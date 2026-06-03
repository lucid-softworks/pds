// Email-action tokens.
//
// Three flows share the same machinery (confirm address, change address,
// reset password). Each token is 160 bits from `randomBytes(20)`, rendered
// as 32 lowercase base32 characters. Tokens are single-use — both consume
// paths delete the row on hit — and only one is live per (did, purpose) at
// a time. Issuance wipes any older row first.
//
// See chapter 13 — Authentication.

import { randomBytes } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '~/lib/db'
import { emailTokens, type EmailToken } from '~/lib/db/schema'
import { Unauthorized } from '~/pds/xrpc/errors'

export type EmailPurpose =
  | 'confirm-email'
  | 'update-email'
  | 'reset-password'
  | 'delete-account'
  // Self-custody PLC ops. The user already has a session; we still gate the
  // signing call on an email round-trip because the op rewrites the DID
  // document (signing key, service endpoint, even the rotation keyset
  // itself) and we want a slow, traceable proof of intent. Chapter 20.
  | 'plc-operation-signature'

const DEFAULT_TTL_SECONDS: Record<EmailPurpose, number> = {
  'confirm-email': 60 * 60 * 24,
  'update-email': 60 * 60 * 24,
  // Password resets are the highest-value flow and the most likely to be
  // phished out of an inbox; a one-hour window is the spec's recommendation.
  'reset-password': 60 * 60,
  // Account deletion is irreversible; keep the window tight, same reasoning
  // as reset-password.
  'delete-account': 60 * 60,
  // PLC signing happens immediately after the user receives the token — the
  // client pastes it back into `signPlcOperation` on the same call. 15 mins
  // is enough for inbox latency and not much more.
  'plc-operation-signature': 60 * 15,
}

export async function issueEmailToken(args: {
  did: string
  purpose: EmailPurpose
  newEmail?: string
  ttlSeconds?: number
}): Promise<{ token: string; expiresAt: Date }> {
  const ttl = args.ttlSeconds ?? DEFAULT_TTL_SECONDS[args.purpose]
  const expiresAt = new Date(Date.now() + ttl * 1000)
  const token = generateToken()

  // Only one live token per (did, purpose). Drop any prior one before
  // inserting; without this an issuance-spam attacker could let a stale
  // token linger until expiry.
  await db
    .delete(emailTokens)
    .where(
      and(
        eq(emailTokens.did, args.did),
        eq(emailTokens.purpose, args.purpose),
      ),
    )

  await db.insert(emailTokens).values({
    did: args.did,
    purpose: args.purpose,
    token,
    newEmail: args.newEmail ?? null,
    expiresAt,
  })

  return { token, expiresAt }
}

export async function consumeEmailToken(args: {
  did: string
  purpose: EmailPurpose
  token: string
}): Promise<EmailToken> {
  const rows = await db
    .select()
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.did, args.did),
        eq(emailTokens.purpose, args.purpose),
        eq(emailTokens.token, args.token),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw Unauthorized('invalid or expired token', 'InvalidToken')
  }
  await deleteRow(row)
  if (row.expiresAt.getTime() <= Date.now()) {
    throw Unauthorized('invalid or expired token', 'ExpiredToken')
  }
  return row
}

export async function consumeEmailTokenByToken(
  purpose: EmailPurpose,
  token: string,
): Promise<EmailToken> {
  // Be lenient on what we accept: bsky.app's reset-password UI sometimes
  // uppercases the input as the user types and pastes can pick up
  // surrounding whitespace. Our generator only emits lowercase + hyphen,
  // so normalising on read costs nothing and the user gets a working
  // reset on the first try instead of staring at "invalid or expired"
  // for typing the same code they were emailed.
  const normalized = token.trim().toLowerCase()
  const rows = await db
    .select()
    .from(emailTokens)
    .where(
      and(eq(emailTokens.token, normalized), eq(emailTokens.purpose, purpose)),
    )
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw Unauthorized('invalid or expired token', 'InvalidToken')
  }
  await deleteRow(row)
  if (row.expiresAt.getTime() <= Date.now()) {
    throw Unauthorized('invalid or expired token', 'ExpiredToken')
  }
  return row
}

/** Best-effort cleanup of any row whose expiry has passed. Cheap on Postgres
 *  with the (did, purpose, token) PK; safe to call from any flow. Not wired
 *  into a cron yet — the consume paths already self-delete on hit. */
export async function purgeExpiredEmailTokens(): Promise<void> {
  await db.delete(emailTokens).where(lt(emailTokens.expiresAt, new Date()))
}

function generateToken(): string {
  // bsky.app's reset-password / email-confirm UIs regex-validate the token
  // as `XXXXX-XXXXX` before submitting (and the same shape is what the
  // official PDS issues). The form usually shows the field in caps to
  // signal "this is a code, not free text", so we emit uppercase to match
  // what the user will retype. The `consumeEmailTokenByToken` lookup
  // normalises to lowercase, so the stored row stays in a canonical case
  // either way.
  // 8 random bytes → 13 base32 chars, slice the first 10, split 5+5.
  // ~50 bits of entropy is fine for a 1-hour single-use token.
  const raw = base32(randomBytes(8)).slice(0, 10).toUpperCase()
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`
}

async function deleteRow(row: EmailToken): Promise<void> {
  await db
    .delete(emailTokens)
    .where(
      and(
        eq(emailTokens.did, row.did),
        eq(emailTokens.purpose, row.purpose),
        eq(emailTokens.token, row.token),
      ),
    )
}

// RFC 4648 base32, lowercase, no padding. 20 bytes (160 bits) → 32 chars.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] ?? 0)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return out
}
