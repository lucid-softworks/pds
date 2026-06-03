// Auth gate for the /admin web UI.
//
// Unlike the com.atproto.admin.* XRPC surface (which uses HTTP Basic with a
// dedicated operator-password hash), the web UI is gated by *handle*: set
// PDS_ADMIN_HANDLE in env, then log in as that account through the normal
// flow. The UI mints its own short-lived session cookie scoped to the
// admin UI; each request re-checks that the current account row's handle
// still matches the env (so a handle rotation immediately revokes UI
// access without invalidating any per-account session token).
//
// We deliberately don't reuse the user-facing access JWT — those live in
// localStorage on the client and don't ride along on plain navigation. A
// dedicated HttpOnly cookie makes the UI work with simple links / form
// submits.

import { eq } from 'drizzle-orm'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'

export const ADMIN_SESSION_COOKIE = 'pds_admin_session'
export const ADMIN_CSRF_COOKIE = 'pds_admin_csrf'
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 // 1 hour

type AdminSessionClaims = JWTPayload & {
  scope: 'admin-ui'
  sub: string // did
  handle: string
}

export type AdminSessionAccount = {
  did: string
  handle: string
  email: string
}

/** Mint a fresh admin-UI session JWT. Caller (the login handler) is
 *  responsible for setting it as an HttpOnly cookie. */
export async function signAdminSessionCookie(args: {
  did: string
  handle: string
}): Promise<{ jwt: string; expiresAt: Date }> {
  const cfg = getConfig()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ADMIN_SESSION_TTL_SECONDS
  const jwt = await new SignJWT({ scope: 'admin-ui', handle: args.handle })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.serviceDid)
    .setAudience(cfg.serviceDid)
    .setSubject(args.did)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(cfg.jwtSecret)
  return { jwt, expiresAt: new Date(exp * 1000) }
}

/** Read the admin session from the request cookies, verify the JWT, and
 *  confirm the account's *current* handle still matches PDS_ADMIN_HANDLE.
 *  Returns the account on success; null on every other case so the caller
 *  can render the login form. */
export async function readAdminSession(
  request: Request,
): Promise<AdminSessionAccount | null> {
  const cfg = getConfig()
  if (!cfg.adminHandle) return null
  const jwt = readCookie(request, ADMIN_SESSION_COOKIE)
  if (!jwt) return null
  let claims: AdminSessionClaims
  try {
    const result = await jwtVerify<AdminSessionClaims>(jwt, cfg.jwtSecret, {
      issuer: cfg.serviceDid,
      audience: cfg.serviceDid,
    })
    claims = result.payload
  } catch {
    return null
  }
  if (claims.scope !== 'admin-ui' || typeof claims.sub !== 'string') {
    return null
  }
  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.did, claims.sub))
    .limit(1)
  const account = rows[0]
  if (!account) return null
  if (account.status !== 'active') return null
  if (account.handle !== cfg.adminHandle) return null
  return { did: account.did, handle: account.handle, email: account.email }
}

/** Build the `Set-Cookie` header value for the admin session. */
export function adminSessionCookieHeader(
  jwt: string,
  expiresAt: Date,
): string {
  return cookieHeader(ADMIN_SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/admin',
    expires: expiresAt,
  })
}

/** Build the Set-Cookie header that clears the admin session. */
export function adminSessionClearHeader(): string {
  return cookieHeader(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/admin',
    expires: new Date(0),
  })
}

/** Read a cookie value by name from the request. */
export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie')
  if (!raw) return null
  const prefix = `${name}=`
  for (const part of raw.split(/;\s*/)) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length))
    }
  }
  return null
}

/** Format a Set-Cookie value. Small, self-contained — no cookie lib. */
export function cookieHeader(
  name: string,
  value: string,
  opts: {
    httpOnly?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
    path?: string
    expires?: Date
    maxAge?: number
    secure?: boolean
  } = {},
): string {
  const segs = [`${name}=${encodeURIComponent(value)}`]
  if (opts.path) segs.push(`Path=${opts.path}`)
  if (opts.expires) segs.push(`Expires=${opts.expires.toUTCString()}`)
  if (opts.maxAge !== undefined) segs.push(`Max-Age=${opts.maxAge}`)
  if (opts.sameSite) segs.push(`SameSite=${opts.sameSite}`)
  if (opts.httpOnly) segs.push('HttpOnly')
  if (opts.secure || isProduction()) segs.push('Secure')
  return segs.join('; ')
}

function isProduction(): boolean {
  return !getConfig().publicUrl.startsWith('http://localhost')
}
