// Session lifecycle.
//
// "Create a session" means: issue an access JWT + refresh JWT, persist the
// refresh token's jti in the database so it can be revoked. The access
// token is stateless — it isn't stored. Verification is purely signature +
// expiry.
//
// Login looks up an account by handle / DID / email, verifies the password,
// then mints a pair. Refresh rotates: the old jti is deleted and a brand-new
// pair is issued, so a leaked refresh token is good for exactly one use.
//
// See chapter 13 — Authentication.

import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, refreshTokens, type Account } from '~/lib/db/schema'
import { Unauthorized, Forbidden } from '~/pds/xrpc/errors'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from './jwt'
import { verifyPassword } from './password'

export type IssuedSession = {
  accessJwt: string
  refreshJwt: string
}

export async function createSessionTokens(did: string): Promise<IssuedSession> {
  const access = await signAccessToken(did)
  const refresh = await signRefreshToken(did)
  await db.insert(refreshTokens).values({
    jti: refresh.jti,
    did,
    expiresAt: new Date(refresh.exp * 1000),
  })
  return { accessJwt: access.jwt, refreshJwt: refresh.jwt }
}

/** Look up an account by handle, DID, or email. Returns null on miss. */
export async function findAccountByIdentifier(
  identifier: string,
): Promise<Account | null> {
  const id = identifier.trim()
  if (id.length === 0) return null
  // Handle syntax forces lowercase; DIDs and emails are case-sensitive and
  // we match them exactly as the account row stored them.
  const isEmail = id.includes('@')
  const isDid = id.startsWith('did:')
  const lookup = isEmail || isDid ? id : id.toLowerCase()
  const column = isEmail
    ? accounts.email
    : isDid
      ? accounts.did
      : accounts.handle
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(column, lookup))
    .limit(1)
  return rows[0] ?? null
}

/** Verify password, return tokens. Throws Unauthorized on miss. */
export async function loginWithPassword(
  identifier: string,
  password: string,
): Promise<{ account: Account; tokens: IssuedSession }> {
  const account = await findAccountByIdentifier(identifier)
  // Same error for "not found" and "wrong password" — don't leak which.
  if (!account) {
    throw Unauthorized('invalid identifier or password', 'AuthenticationRequired')
  }
  const ok = await verifyPassword(password, account.passwordHash)
  if (!ok) {
    throw Unauthorized('invalid identifier or password', 'AuthenticationRequired')
  }
  assertAccountActive(account)
  const tokens = await createSessionTokens(account.did)
  return { account, tokens }
}

/** Validate the refresh JWT, rotate it, return a new pair.
 *  Throws Unauthorized on invalid / revoked. */
export async function rotateRefreshToken(refreshJwt: string): Promise<{
  did: string
  tokens: IssuedSession
}> {
  const claims = await verifyRefreshTokenOrThrow(refreshJwt)
  // Confirm the jti is still on file before issuing a new pair. There's a
  // tiny TOCTOU window between this select and the delete below, but a
  // racing second refresh would just see the delete come back empty.
  const existing = await db
    .select({ jti: refreshTokens.jti })
    .from(refreshTokens)
    .where(eq(refreshTokens.jti, claims.jti))
    .limit(1)
  if (!existing[0]) {
    throw Unauthorized('refresh token revoked or already used', 'ExpiredToken')
  }
  await db.delete(refreshTokens).where(eq(refreshTokens.jti, claims.jti))
  const tokens = await createSessionTokens(claims.sub)
  return { did: claims.sub, tokens }
}

/** Delete the refresh token row identified by this JWT. Idempotent. */
export async function revokeRefreshToken(refreshJwt: string): Promise<void> {
  let jti: string
  try {
    const claims = await verifyRefreshToken(refreshJwt)
    jti = claims.jti
  } catch {
    // Logout is best-effort: an already-expired or malformed token still
    // means "go away," not 500.
    return
  }
  await db.delete(refreshTokens).where(eq(refreshTokens.jti, jti))
}

/** Map account.status → the right 403 name. Throws if not active. */
export function assertAccountActive(account: { status: string }): void {
  if (account.status === 'active') return
  const name =
    account.status === 'takendown'
      ? 'AccountTakedown'
      : account.status === 'deactivated'
        ? 'AccountDeactivated'
        : account.status === 'deleted'
          ? 'AccountDeleted'
          : 'AccountSuspended'
  throw Forbidden(`account is ${account.status}`, name)
}

async function verifyRefreshTokenOrThrow(refreshJwt: string) {
  try {
    return await verifyRefreshToken(refreshJwt)
  } catch (err) {
    throw mapJwtError(err)
  }
}

function mapJwtError(err: unknown): Error {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ERR_JWT_EXPIRED') {
    return Unauthorized('refresh token expired', 'ExpiredToken')
  }
  return Unauthorized('invalid refresh token', 'InvalidToken')
}
