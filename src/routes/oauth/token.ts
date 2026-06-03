// TanStack Start API route: POST /oauth/token
//
// The OAuth token endpoint. In this session we implement only the
// `refresh_token` grant — the `authorization_code` grant is gated on the
// /oauth/authorize and /oauth/par endpoints, which are deferred (see the
// chapter-21 doc and the stubs in this directory).
//
// Wire shape:
//   - Request body is application/x-www-form-urlencoded (OAuth standard).
//   - The DPoP proof goes in the `DPoP:` header.
//   - On success: 200 with the token response JSON.
//   - On failure: 4xx with `{ error, error_description }` per RFC 6749 §5.2.
//
// See chapter 21 — OAuth.

import { createFileRoute } from '@tanstack/react-router'
import { verifyDpopProof } from '~/pds/oauth/dpop'
import {
  consumeOauthRefreshToken,
  signOauthAccessToken,
  signOauthRefreshToken,
} from '~/pds/oauth/tokens'

export const Route = createFileRoute('/oauth/token')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ct = request.headers.get('content-type') ?? ''
        if (!ct.toLowerCase().includes('application/x-www-form-urlencoded')) {
          return errorResponse(
            400,
            'invalid_request',
            'token endpoint requires application/x-www-form-urlencoded',
          )
        }
        const body = await request.text()
        const form = new URLSearchParams(body)
        const grantType = form.get('grant_type')
        if (grantType !== 'refresh_token') {
          // The spec answer for an unimplemented grant is unsupported_grant_type.
          return errorResponse(
            400,
            'unsupported_grant_type',
            grantType
              ? `grant_type=${grantType} is not supported`
              : 'grant_type is required',
          )
        }
        const refreshToken = form.get('refresh_token')
        if (!refreshToken) {
          return errorResponse(
            400,
            'invalid_request',
            'refresh_token parameter is required',
          )
        }
        const dpopHeader = request.headers.get('dpop') ?? ''
        let dpop: { jkt: string }
        try {
          dpop = await verifyDpopProof({
            dpopHeader,
            httpMethod: 'POST',
            httpUri: request.url,
          })
        } catch (err) {
          // RFC 9449 — bad DPoP proof returns invalid_dpop_proof + 400.
          return errorResponse(
            400,
            'invalid_dpop_proof',
            (err as Error).message,
          )
        }

        let consumed: { did: string; scope: string }
        try {
          consumed = await consumeOauthRefreshToken({
            jwt: refreshToken,
            dpopJkt: dpop.jkt,
          })
        } catch (err) {
          // Most refresh-token failures collapse to invalid_grant (revoked,
          // expired, wrong DPoP key, malformed JWT). 400 per RFC 6749.
          return errorResponse(
            400,
            'invalid_grant',
            (err as Error).message,
          )
        }

        // Honour a narrower `scope` parameter if the client downscopes on
        // refresh, but never widen beyond what the original grant covered.
        const requestedScope = form.get('scope')
        const grantedScope = narrowScope(consumed.scope, requestedScope)

        const access = await signOauthAccessToken({
          did: consumed.did,
          scope: grantedScope,
          dpopJkt: dpop.jkt,
        })
        const refresh = await signOauthRefreshToken({
          did: consumed.did,
          dpopJkt: dpop.jkt,
          scope: grantedScope,
        })
        const payload = {
          access_token: access.jwt,
          token_type: 'DPoP',
          expires_in: access.exp - Math.floor(Date.now() / 1000),
          refresh_token: refresh.jwt,
          scope: grantedScope,
          sub: consumed.did,
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            pragma: 'no-cache',
          },
        })
      },
    },
  },
})

function errorResponse(
  status: number,
  error: string,
  description: string,
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}

/** Refresh requests can ask for a narrower scope (RFC 6749 §6); they can
 *  never broaden. We intersect token-by-token; an empty intersection falls
 *  back to the original grant rather than emptying the scope entirely. */
function narrowScope(granted: string, requested: string | null): string {
  if (!requested || requested.trim().length === 0) return granted
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean))
  const wanted = requested.split(/\s+/).filter(Boolean)
  const out = wanted.filter((s) => grantedSet.has(s))
  if (out.length === 0) return granted
  return out.join(' ')
}
