// TanStack Start API route: POST /oauth/revoke
//
// RFC 7009 token revocation. The client POSTs a token (and optionally a
// `token_type_hint`) as application/x-www-form-urlencoded. We delete the
// matching row from `refresh_tokens` and return 200 unconditionally — per
// the spec, the endpoint must NOT leak whether a token was valid or not.
//
// We currently only revoke refresh tokens; access tokens are stateless
// (signature + expiry) and there's nothing to delete. Most clients will hint
// `token_type_hint=refresh_token` anyway; if they hint `access_token` we
// still return 200, just without doing anything.
//
// See chapter 21 — OAuth.

import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { refreshTokens } from '~/lib/db/schema'
import { validateOauthRefreshToken } from '~/pds/oauth/tokens'

export const Route = createFileRoute('/oauth/revoke')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ct = request.headers.get('content-type') ?? ''
        if (!ct.toLowerCase().includes('application/x-www-form-urlencoded')) {
          // Even error replies on /revoke are best-effort; return 200 with an
          // empty body rather than tipping off a probe. The spec allows
          // returning errors for client/parameter problems, but the only
          // signal the client is supposed to react to is success.
          return new Response(null, { status: 200 })
        }
        const form = new URLSearchParams(await request.text())
        const token = form.get('token')
        if (!token) {
          return new Response(null, { status: 200 })
        }
        // Try the refresh-token path. The DPoP header is *optional* on
        // revocation per RFC 9449 §6.2 — a client that's lost their key
        // still needs a way to invalidate the matching row. We do a
        // best-effort signature verify against the token (using the cnf.jkt
        // baked into the JWT body so we can call the same validate path),
        // ignore the result, and delete the row by jti regardless.
        try {
          const decoded = decodeJwtBody(token)
          const jti = typeof decoded.jti === 'string' ? decoded.jti : null
          if (!jti) {
            return new Response(null, { status: 200 })
          }
          try {
            await validateOauthRefreshToken({
              jwt: token,
              dpopJkt: extractCnfJkt(decoded) ?? '',
            })
          } catch {
            // Failure here doesn't block revocation — we still want the row
            // gone for an expired-but-known token, a malformed token whose
            // jti happens to be on file, etc. The 200-no-leak rule wins.
          }
          await db.delete(refreshTokens).where(eq(refreshTokens.jti, jti))
        } catch {
          // Malformed JWT, missing row, anything else — silent 200.
        }
        return new Response(null, { status: 200 })
      },
    },
  },
})

function decodeJwtBody(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return {}
  const body = parts[1]
  if (!body) return {}
  try {
    return JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
  } catch {
    return {}
  }
}

function extractCnfJkt(claims: Record<string, unknown>): string | null {
  const cnf = claims['cnf']
  if (cnf && typeof cnf === 'object' && 'jkt' in cnf) {
    const jkt = (cnf as { jkt: unknown }).jkt
    if (typeof jkt === 'string') return jkt
  }
  return null
}
