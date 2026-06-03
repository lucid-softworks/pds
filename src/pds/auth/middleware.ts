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
import { getConfig } from '~/lib/config'
import { Forbidden, Unauthorized } from '~/pds/xrpc/errors'
import { verifyDpopProof } from '~/pds/oauth/dpop'
import { verifyOauthAccessToken } from '~/pds/oauth/tokens'
import { verifyAccessToken, verifyRefreshToken } from './jwt'
import { verifyPassword } from './password'
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

/** Validate a DPoP-bound OAuth access token and its paired DPoP proof.
 *
 *  The caller passes the `Authorization: DPoP <jwt>` value, the `DPoP:` proof
 *  header, and the live `Request` so we can pull method + URL for the proof's
 *  `htm` / `htu` binding. We verify the access token (signature + claims),
 *  then verify the proof with `expectedJkt` set to the token's `cnf.jkt` so
 *  the proof-of-possession is enforced on this exact request. The returned
 *  account carries the granted `scope` string from the token. */
export async function requireOauthAccess(args: {
  authorization?: string
  dpopProof?: string
  request: Request
  opts?: AuthOptions
}): Promise<AuthenticatedAccount & { scope: string }> {
  const token = parseDpop(args.authorization)
  if (!args.dpopProof || args.dpopProof.trim().length === 0) {
    throw Unauthorized('DPoP proof header required', 'AuthMissing')
  }
  const claims = await verifyOauthAccess(token)
  try {
    await verifyDpopProof({
      dpopHeader: args.dpopProof,
      httpMethod: args.request.method,
      httpUri: stripQuery(args.request.url),
      expectedJkt: claims.jkt,
    })
  } catch (err) {
    // Every DPoP-side failure (signature, htm/htu, iat, replay, jkt mismatch)
    // maps to InvalidToken — the client presented credentials, they just
    // don't bind to this request.
    throw Unauthorized(
      (err as Error).message || 'DPoP proof invalid',
      'InvalidToken',
    )
  }
  const account = await loadAccount(claims.did, args.opts)
  return { ...account, scope: claims.scope }
}

/** Accept either the legacy `Bearer <session-jwt>` flow or the OAuth
 *  `DPoP <oauth-jwt>` + `DPoP:` proof pair. The returned account carries a
 *  `scope` field that's `'session'` for the legacy path or whatever the
 *  OAuth token granted. Dispatcher-friendly: handlers that want to support
 *  both schemes call this with the request's headers as-is. */
export async function requireEitherAuth(args: {
  authorization?: string
  dpopProof?: string
  request: Request
  opts?: AuthOptions
}): Promise<AuthenticatedAccount & { scope: string }> {
  const scheme = detectScheme(args.authorization)
  if (scheme === 'bearer') {
    const account = await requireAccessAuth(args.authorization, args.opts)
    return { ...account, scope: 'session' }
  }
  if (scheme === 'dpop') {
    return requireOauthAccess(args)
  }
  if (scheme === 'missing') {
    throw Unauthorized('authorization header required', 'AuthMissing')
  }
  throw Unauthorized(
    'authorization scheme must be Bearer or DPoP',
    'InvalidToken',
  )
}

/** Atproto OAuth scopes the resource server cares about today.
 *
 *  - `atproto` — minimal "who am I" scope. Lets the client confirm the
 *    user's identity and read public data, but not write records.
 *  - `transition:generic` — the broader scope an OAuth client requests to
 *    perform writes on the user's behalf. Implies `atproto`. */
export type RequiredScope = 'atproto' | 'transition:generic'

/** Throw Forbidden `InsufficientScope` if the requested scope isn't a
 *  subset of the granted scope. Session-flow auth (`scope === 'session'`)
 *  has every scope implicitly — the legacy first-party flow predates the
 *  OAuth-scope concept and is treated as fully privileged. Only OAuth
 *  tokens carry a scope claim, and we enforce it here. */
export function requireScope(
  account: AuthenticatedAccount & { scope: string },
  required: RequiredScope,
): void {
  if (account.scope === 'session') return
  const granted = account.scope.split(/\s+/).filter((s) => s.length > 0)
  if (granted.includes(required)) return
  // `transition:generic` is a strict superset of `atproto` — the official
  // atproto profile defines it that way, and clients that asked for the
  // broader scope expect the narrower one to come along for the ride.
  if (required === 'atproto' && granted.includes('transition:generic')) return
  throw Forbidden(
    `token scope '${account.scope}' lacks required '${required}'`,
    'InsufficientScope',
  )
}

/** Sugar over `requireEitherAuth + requireScope` so handlers stay a single
 *  line at the top of the body. Returns the same `AuthenticatedAccount &
 *  { scope }` shape as `requireEitherAuth`. */
export async function requireAuthWithScope(
  ctx: { authorization?: string; dpopProof?: string; request: Request },
  scope: RequiredScope,
  opts?: AuthOptions,
): Promise<AuthenticatedAccount & { scope: string }> {
  const account = await requireEitherAuth({
    authorization: ctx.authorization,
    dpopProof: ctx.dpopProof,
    request: ctx.request,
    opts,
  })
  requireScope(account, scope)
  return account
}

/** Validate the Authorization header as HTTP Basic with the configured admin
 *  password. The username field is conventionally `admin` and is ignored.
 *  Throws when the admin surface is disabled (no hash configured), the
 *  header is missing / malformed, or the password is wrong.
 *
 *  See chapter 19 — Moderation. */
export async function requireAdmin(
  authorization: string | undefined,
): Promise<void> {
  const cfg = getConfig()
  if (!cfg.adminPasswordHash) {
    throw Forbidden('admin surface is disabled', 'AdminDisabled')
  }
  if (!authorization || !/^basic\s+/i.test(authorization.trim())) {
    throw Unauthorized('Basic auth required', 'AuthMissing')
  }
  const b64 = authorization.trim().replace(/^basic\s+/i, '').trim()
  let decoded: string
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    throw Unauthorized('malformed Basic auth', 'InvalidToken')
  }
  const idx = decoded.indexOf(':')
  if (idx < 0) {
    throw Unauthorized('malformed Basic auth', 'InvalidToken')
  }
  const password = decoded.slice(idx + 1)
  const stored = cfg.adminPasswordHash
  // Plaintext-fallback prefix means PDS_ADMIN_PASSWORD was set instead of the
  // pre-hashed form. Compare directly; documented as dev-only.
  const ok = stored.startsWith('plain:')
    ? timingSafeEqualStr(password, stored.slice('plain:'.length))
    : await verifyPassword(password, stored)
  if (!ok) {
    throw Unauthorized('admin password incorrect', 'InvalidToken')
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
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

function parseDpop(authorization: string | undefined): string {
  if (!authorization || authorization.trim().length === 0) {
    throw Unauthorized('authorization header required', 'AuthMissing')
  }
  const match = /^dpop\s+(.+)$/i.exec(authorization.trim())
  if (!match || !match[1]) {
    throw Unauthorized('authorization scheme must be DPoP', 'InvalidToken')
  }
  return match[1].trim()
}

function detectScheme(
  authorization: string | undefined,
): 'bearer' | 'dpop' | 'missing' | 'unknown' {
  if (!authorization || authorization.trim().length === 0) return 'missing'
  const lower = authorization.trim().toLowerCase()
  if (lower.startsWith('bearer ')) return 'bearer'
  if (lower.startsWith('dpop ')) return 'dpop'
  return 'unknown'
}

function stripQuery(url: string): string {
  // RFC 9449 §4.2: `htu` compares the URI with query + fragment removed. The
  // verifier normalises both sides anyway, but stripping here keeps the
  // comparison surface obvious.
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

async function verifyAccess(token: string) {
  try {
    return await verifyAccessToken(token)
  } catch (err) {
    throw mapJwtError(err)
  }
}

async function verifyOauthAccess(token: string) {
  try {
    return await verifyOauthAccessToken(token)
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
