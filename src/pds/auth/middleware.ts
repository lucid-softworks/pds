// Auth middleware for XRPC handlers.
//
// Handlers that need an authenticated caller call `requireAccessAuth` with
// the raw Authorization header. We strip the `Bearer ` prefix, verify the
// JWT signature + expiry, look up the account, and return a small subset of
// its fields. Throws `XrpcError` with the lexicon-defined error names on any
// failure so the dispatcher can render the canonical envelope.
//
// See chapter 13 — Authentication.

import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, refreshTokens } from '~/lib/db/schema'
import { Forbidden, Unauthorized } from '~/pds/xrpc/errors'
import { verifyAccessToken, verifyRefreshToken } from './jwt'
import { assertAccountActive } from './session'

export type AuthenticatedAccount = {
  did: string
  handle: string
  email: string
  status: string
}

/** Per-call relaxations of the default "must be active" gate. Takendown and
 *  deleted accounts are never reachable through any of these — only the
 *  reversible `deactivated` state can be opted into, and only for endpoints
 *  that explicitly need it (checkAccountStatus, activateAccount). */
export type AuthOptions = {
  /** Allow callers whose account is currently `deactivated`. Default false. */
  allowDeactivated?: boolean
}

/** Validate the Authorization header's access JWT and return the account.
 *  Throws XrpcError on missing / invalid / suspended. */
export async function requireAccessAuth(
  authorization: string | undefined,
  opts?: AuthOptions,
): Promise<AuthenticatedAccount> {
  const token = parseBearer(authorization)
  const claims = await verifyAccess(token)
  return loadAccount(claims.sub, opts)
}

/** Same but for refresh tokens (used by refreshSession / deleteSession). */
export async function requireRefreshAuth(
  authorization: string | undefined,
): Promise<{ did: string; jti: string }> {
  const token = parseBearer(authorization)
  const claims = await verifyRefresh(token)
  const rows = await db
    .select({ jti: refreshTokens.jti })
    .from(refreshTokens)
    .where(eq(refreshTokens.jti, claims.jti))
    .limit(1)
  if (!rows[0]) {
    throw Unauthorized('refresh token revoked or already used', 'ExpiredToken')
  }
  return { did: claims.sub, jti: claims.jti }
}

/** Optional auth — returns the account if present, null if absent.
 *  Still throws on invalid. */
export async function optionalAccessAuth(
  authorization: string | undefined,
  opts?: AuthOptions,
): Promise<AuthenticatedAccount | null> {
  if (!authorization || authorization.trim().length === 0) return null
  const token = parseBearer(authorization)
  const claims = await verifyAccess(token)
  return loadAccount(claims.sub, opts)
}

function parseBearer(authorization: string | undefined): string {
  if (!authorization || authorization.trim().length === 0) {
    throw Unauthorized('authorization header required', 'AuthMissing')
  }
  // Case-insensitive `Bearer ` prefix.
  const match = /^bearer\s+(.+)$/i.exec(authorization.trim())
  if (!match || !match[1]) {
    throw Unauthorized('authorization scheme must be Bearer', 'InvalidToken')
  }
  return match[1].trim()
}

async function verifyAccess(token: string) {
  try {
    return await verifyAccessToken(token)
  } catch (err) {
    throw mapJwtError(err)
  }
}

async function verifyRefresh(token: string) {
  try {
    return await verifyRefreshToken(token)
  } catch (err) {
    throw mapJwtError(err)
  }
}

async function loadAccount(
  did: string,
  opts?: AuthOptions,
): Promise<AuthenticatedAccount> {
  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const acct = rows[0]
  if (!acct) {
    // JWT verified but the account is gone — treat as a stale token.
    throw Unauthorized('account no longer exists', 'InvalidToken')
  }
  // Active is always fine. Deactivated is fine *if* the caller opted in
  // (the only endpoints that do are checkAccountStatus and activateAccount —
  // a user who deactivated their account still needs a way out). Takendown
  // and deleted are server-side disabled, never reachable through XRPC auth.
  if (acct.status === 'active') return acct
  if (acct.status === 'deactivated' && opts?.allowDeactivated) return acct
  if (acct.status === 'deactivated') {
    throw Forbidden('account is deactivated', 'AccountDeactivated')
  }
  if (acct.status === 'takendown') {
    throw Forbidden('account is takendown', 'AccountTakedown')
  }
  if (acct.status === 'deleted') {
    throw Forbidden('account is deleted', 'AccountDeleted')
  }
  // Anything else (e.g. 'suspended') — defer to the shared helper for the
  // canonical error name.
  assertAccountActive(acct)
  return acct
}

function mapJwtError(err: unknown): Error {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ERR_JWT_EXPIRED') {
    return Unauthorized('token expired', 'ExpiredToken')
  }
  return Unauthorized('invalid token', 'InvalidToken')
}
