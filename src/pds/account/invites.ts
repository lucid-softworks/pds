// Invite codes.
//
// When PDS_INVITE_REQUIRED=true, createAccount demands a valid code from this
// table. The string format is `pds-xxxxx-xxxxx` over a 32-char base32 alphabet
// — 10 characters of entropy, ~50 bits, well clear of brute force at any sane
// signup rate.
//
// Validation and consumption are split: `peekInviteCode` is the pre-flight
// check (look up, verify usable, verify forAccount allows the candidate DID),
// `reserveInviteCode` is the commit (decrement uses_remaining + write the
// audit row). The pre-flight / consume split is documented in `create.ts` —
// the goal is to never half-spend a code on a signup that fails after the
// DID is derived.
//
// See chapter 12 — Account creation.

import { randomBytes } from 'node:crypto'
import { base32 } from 'multiformats/bases/base32'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { db } from '~/lib/db'
import {
  inviteCodes,
  inviteCodeUses,
  type InviteCode,
  type InviteCodeUse,
} from '~/lib/db/schema'
import { Unauthorized } from '~/pds/xrpc/errors'

// Same widening as `auth/app_password.ts`: the db union collapses
// `.returning` to its no-arg form, so we re-type for the column-keyed call.
const pg = db as unknown as PgDatabase<PgQueryResultHKT>

/** Produce one well-formed `pds-xxxxx-xxxxx` invite string. ~50 bits of
 *  entropy from 8 random bytes encoded as 10 chars of base32-lowercase. */
export function generateInviteCode(): string {
  // 8 bytes → 13 base32 chars (no padding from `base32.baseEncode`); we slice
  // to 10 so the human-readable form is two 5-char groups.
  const raw = base32.baseEncode(randomBytes(8)).slice(0, 10)
  return `pds-${raw.slice(0, 5)}-${raw.slice(5, 10)}`
}

/** Validate a code is currently usable by `candidateDid`, without mutating.
 *  Throws `InvalidInviteCode` (401) on miss / disabled / spent / wrong-
 *  recipient. Returns the row on success.
 *
 *  `candidateDid` is the DID we *plan* to issue. Pass null only when the DID
 *  isn't derived yet but you still want to check existence + remaining uses
 *  (the createAccount pre-flight does this — `forAccount` is rare in the
 *  open-signup-with-targeted-invite case). */
export async function peekInviteCode(args: {
  code: string
  candidateDid: string | null
}): Promise<InviteCode> {
  const rows = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, args.code))
    .limit(1)
  const row = rows[0]
  if (!row) throw Unauthorized('unknown invite code', 'InvalidInviteCode')
  if (row.disabled) {
    throw Unauthorized('invite code disabled', 'InvalidInviteCode')
  }
  if (row.usesRemaining <= 0) {
    throw Unauthorized('invite code exhausted', 'InvalidInviteCode')
  }
  if (row.forAccount && args.candidateDid && row.forAccount !== args.candidateDid) {
    throw Unauthorized('invite code reserved for another account', 'InvalidInviteCode')
  }
  return row
}

/** Atomically consume one use of a code on behalf of `usedBy`. Throws
 *  `InvalidInviteCode` if the code is missing, disabled, exhausted, or
 *  reserved for a different DID at the moment of consumption.
 *
 *  Implementation note: we run the decrement as a guarded UPDATE so two
 *  concurrent callers can't both drain the last use. The audit-row insert
 *  uses ON CONFLICT DO NOTHING — the (code, usedBy) PK means a given DID
 *  can't double-count against the same code. */
export async function reserveInviteCode(args: {
  code: string
  usedBy: string
}): Promise<void> {
  const peeked = await peekInviteCode({
    code: args.code,
    candidateDid: args.usedBy,
  })
  // Guarded decrement: the where-clause re-checks the conditions, so a racing
  // caller that won the previous round will leave us with 0 rows updated.
  const updated = await pg
    .update(inviteCodes)
    .set({
      usesRemaining: peeked.usesRemaining - 1,
      usesTotal: peeked.usesTotal + 1,
    })
    .where(
      and(
        eq(inviteCodes.code, args.code),
        eq(inviteCodes.usesRemaining, peeked.usesRemaining),
      ),
    )
    .returning({ code: inviteCodes.code })
  if (updated.length === 0) {
    throw Unauthorized('invite code race-lost', 'InvalidInviteCode')
  }
  await db
    .insert(inviteCodeUses)
    .values({ code: args.code, usedBy: args.usedBy })
    .onConflictDoNothing()
}

/** Mint one code. `createdBy=null` is the admin-minted shape; passing a DID
 *  attributes the code to that account (used for the future personal-quota
 *  feature). */
export async function createOneInviteCode(args: {
  createdBy?: string | null
  forAccount?: string | null
  usesRemaining?: number
}): Promise<{ code: string; usesRemaining: number; createdAt: Date }> {
  const code = generateInviteCode()
  const usesRemaining = args.usesRemaining ?? 1
  const rows = await pg
    .insert(inviteCodes)
    .values({
      code,
      createdBy: args.createdBy ?? null,
      forAccount: args.forAccount ?? null,
      usesRemaining,
    })
    .returning({ createdAt: inviteCodes.createdAt })
  return { code, usesRemaining, createdAt: rows[0]!.createdAt }
}

export type InviteCodeSummary = {
  code: string
  forAccount: string | null
  usesRemaining: number
  usesTotal: number
  disabled: boolean
  createdAt: Date
  uses: Array<{ usedBy: string; usedAt: Date }>
}

/** Codes the given DID minted — used by `getAccountInviteCodes`. Includes the
 *  audit log of who's already redeemed each. */
export async function listInviteCodesForAccount(
  did: string,
): Promise<InviteCodeSummary[]> {
  const codes = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.createdBy, did))
    .orderBy(desc(inviteCodes.createdAt))
  if (codes.length === 0) return []
  const uses = await db
    .select()
    .from(inviteCodeUses)
    .where(
      inArray(
        inviteCodeUses.code,
        codes.map((c) => c.code),
      ),
    )
  const byCode = new Map<string, InviteCodeUse[]>()
  for (const u of uses) {
    const list = byCode.get(u.code) ?? []
    list.push(u)
    byCode.set(u.code, list)
  }
  return codes.map((c) => ({
    code: c.code,
    forAccount: c.forAccount,
    usesRemaining: c.usesRemaining,
    usesTotal: c.usesTotal,
    disabled: c.disabled,
    createdAt: c.createdAt,
    uses: (byCode.get(c.code) ?? []).map((u) => ({
      usedBy: u.usedBy,
      usedAt: u.usedAt,
    })),
  }))
}

