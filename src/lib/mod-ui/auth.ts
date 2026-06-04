// Auth gate for the /mod web UI.
//
// Mirrors the `/admin` pattern (cookie-backed session JWT, scoped to
// /mod) but with a different membership check: the logged-in account
// must have a row in `mod_team`. The `/admin` UI keys off
// PDS_ADMIN_HANDLE — one named operator. `/mod` keys off the team
// roster — N moderators, lead + non-lead.
//
// Admin Basic auth also unlocks the UI: an operator with the admin
// password is always allowed (no cookie required). Mirrors the "admin
// can do anything" invariant from chapter 19.

import { eq } from 'drizzle-orm'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { accounts, modTeam } from '~/lib/db/schema'
import { cookieHeader, readCookie } from '~/lib/admin-ui/auth'

export const MOD_SESSION_COOKIE = 'pds_mod_session'
export const MOD_CSRF_COOKIE = 'pds_mod_csrf'
const MOD_SESSION_TTL_SECONDS = 60 * 60

type ModSessionClaims = JWTPayload & {
  scope: 'mod-ui'
  sub: string
  handle: string
}

export type ModSessionAccount = {
  did: string
  handle: string
  email: string
  role: 'lead' | 'moderator' | 'admin'
}

/** Mint a fresh /mod session JWT after a successful login. */
export async function signModSessionCookie(args: {
  did: string
  handle: string
}): Promise<{ jwt: string; expiresAt: Date }> {
  const cfg = getConfig()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + MOD_SESSION_TTL_SECONDS
  const jwt = await new SignJWT({ scope: 'mod-ui', handle: args.handle })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.serviceDid)
    .setAudience(cfg.serviceDid)
    .setSubject(args.did)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(cfg.jwtSecret)
  return { jwt, expiresAt: new Date(exp * 1000) }
}

/** Read the request's auth and return the moderator on success, or
 *  null so the caller can render the login form. Recognises:
 *    - admin Basic credentials in `Authorization` (always allowed)
 *    - the /mod session cookie + an active mod_team membership */
export async function readModSession(
  request: Request,
): Promise<ModSessionAccount | null> {
  // 1. Admin Basic bypass. Don't bother with the cookie if the header
  //    already proves admin authority.
  const adminBypass = await tryAdminBasic(request)
  if (adminBypass) return adminBypass

  // 2. Cookie session.
  const cfg = getConfig()
  const jwt = readCookie(request, MOD_SESSION_COOKIE)
  if (!jwt) return null
  let claims: ModSessionClaims
  try {
    const result = await jwtVerify<ModSessionClaims>(jwt, cfg.jwtSecret, {
      issuer: cfg.serviceDid,
      audience: cfg.serviceDid,
    })
    claims = result.payload
  } catch {
    return null
  }
  if (claims.scope !== 'mod-ui' || typeof claims.sub !== 'string') return null

  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
      role: modTeam.role,
    })
    .from(accounts)
    .leftJoin(modTeam, eq(modTeam.did, accounts.did))
    .where(eq(accounts.did, claims.sub))
    .limit(1)
  const account = rows[0]
  if (!account) return null
  if (account.status !== 'active') return null
  if (account.role !== 'lead' && account.role !== 'moderator') return null
  return {
    did: account.did,
    handle: account.handle,
    email: account.email,
    role: account.role,
  }
}

/** Set-Cookie value for the /mod session. */
export function modSessionCookieHeader(jwt: string, expiresAt: Date): string {
  return cookieHeader(MOD_SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/mod',
    expires: expiresAt,
  })
}

/** Set-Cookie value that clears the /mod session. */
export function modSessionClearHeader(): string {
  return cookieHeader(MOD_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/mod',
    expires: new Date(0),
  })
}

async function tryAdminBasic(request: Request): Promise<ModSessionAccount | null> {
  const auth = request.headers.get('authorization')
  if (!auth || !/^basic\s+/i.test(auth.trim())) return null
  try {
    // Reuse the canonical admin gate so the password is verified
    // exactly once, the same way, regardless of which UI is hit.
    const { requireAdmin } = await import('~/pds/auth/middleware')
    await requireAdmin(auth)
  } catch {
    return null
  }
  return {
    did: 'admin',
    handle: 'admin',
    email: '',
    role: 'admin',
  }
}
