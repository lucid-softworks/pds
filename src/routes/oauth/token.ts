// TanStack Start API route: POST /oauth/token
//
// The OAuth token endpoint. Implements two grant types:
//
//   - `authorization_code` — initial grant after the user signs in on
//     /oauth/authorize. Exchanges the one-shot code (plus PKCE verifier
//     and DPoP proof) for the first access + refresh JWT pair.
//   - `refresh_token` — subsequent rotations. Exchanges a valid refresh
//     JWT for a fresh pair, single-use (the old row gets deleted).
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
import { verifyPkce } from '~/pds/oauth/pkce'
import {
  consumeOauthCode,
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

        // Both branches need a valid DPoP proof. We verify once and pass
        // the thumbprint down — refresh and code grants each check it
        // against their own bound jkt.
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

        if (grantType === 'authorization_code') {
          return handleAuthorizationCodeGrant(form, dpop.jkt)
        }
        if (grantType === 'refresh_token') {
          return handleRefreshGrant(form, dpop.jkt)
        }
        return errorResponse(
          400,
          'unsupported_grant_type',
          grantType
            ? `grant_type=${grantType} is not supported`
            : 'grant_type is required',
        )
      },
    },
  },
})

// ─── authorization_code grant ──────────────────────────────────────────────

async function handleAuthorizationCodeGrant(
  form: URLSearchParams,
  proofJkt: string,
): Promise<Response> {
  const code = form.get('code')
  const redirectUri = form.get('redirect_uri')
  const clientId = form.get('client_id')
  const codeVerifier = form.get('code_verifier')

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return errorResponse(
      400,
      'invalid_request',
      'authorization_code grant requires code, redirect_uri, client_id, code_verifier',
    )
  }

  let consumed
  try {
    consumed = await consumeOauthCode(code)
  } catch (err) {
    // RFC 6749: missing / expired / used codes all collapse to invalid_grant.
    return errorResponse(400, 'invalid_grant', (err as Error).message)
  }

  if (consumed.dpopJkt !== proofJkt) {
    return errorResponse(
      400,
      'invalid_dpop_proof',
      'DPoP proof key does not match the key the authorization code was bound to',
    )
  }
  if (consumed.redirectUri !== redirectUri) {
    return errorResponse(
      400,
      'invalid_grant',
      'redirect_uri does not match the authorization request',
    )
  }
  if (consumed.clientId !== clientId) {
    return errorResponse(
      400,
      'invalid_grant',
      'client_id does not match the authorization request',
    )
  }

  // PKCE — atproto OAuth requires S256 (enforced at PAR time via the zod
  // schema). verifyPkce throws on mismatch / wrong method.
  if (consumed.codeChallengeMethod !== 'S256') {
    return errorResponse(
      400,
      'invalid_grant',
      `unsupported PKCE method: ${consumed.codeChallengeMethod}`,
    )
  }
  try {
    verifyPkce({
      codeVerifier,
      codeChallenge: consumed.codeChallenge,
      method: 'S256',
    })
  } catch (err) {
    return errorResponse(400, 'invalid_grant', (err as Error).message)
  }

  const access = await signOauthAccessToken({
    did: consumed.did,
    scope: consumed.scope,
    dpopJkt: proofJkt,
  })
  const refresh = await signOauthRefreshToken({
    did: consumed.did,
    dpopJkt: proofJkt,
    scope: consumed.scope,
  })
  return tokenResponse({
    accessJwt: access.jwt,
    accessExp: access.exp,
    refreshJwt: refresh.jwt,
    scope: consumed.scope,
    did: consumed.did,
  })
}

// ─── refresh_token grant ───────────────────────────────────────────────────

async function handleRefreshGrant(
  form: URLSearchParams,
  proofJkt: string,
): Promise<Response> {
  const refreshToken = form.get('refresh_token')
  if (!refreshToken) {
    return errorResponse(
      400,
      'invalid_request',
      'refresh_token parameter is required',
    )
  }
  let consumed: { did: string; scope: string }
  try {
    consumed = await consumeOauthRefreshToken({
      jwt: refreshToken,
      dpopJkt: proofJkt,
    })
  } catch (err) {
    // Most refresh-token failures collapse to invalid_grant (revoked,
    // expired, wrong DPoP key, malformed JWT). 400 per RFC 6749.
    return errorResponse(400, 'invalid_grant', (err as Error).message)
  }

  // Honour a narrower `scope` parameter if the client downscopes on
  // refresh, but never widen beyond what the original grant covered.
  const requestedScope = form.get('scope')
  const grantedScope = narrowScope(consumed.scope, requestedScope)

  const access = await signOauthAccessToken({
    did: consumed.did,
    scope: grantedScope,
    dpopJkt: proofJkt,
  })
  const refresh = await signOauthRefreshToken({
    did: consumed.did,
    dpopJkt: proofJkt,
    scope: grantedScope,
  })
  return tokenResponse({
    accessJwt: access.jwt,
    accessExp: access.exp,
    refreshJwt: refresh.jwt,
    scope: grantedScope,
    did: consumed.did,
  })
}

function tokenResponse(args: {
  accessJwt: string
  accessExp: number
  refreshJwt: string
  scope: string
  did: string
}): Response {
  const payload = {
    access_token: args.accessJwt,
    token_type: 'DPoP',
    expires_in: args.accessExp - Math.floor(Date.now() / 1000),
    refresh_token: args.refreshJwt,
    scope: args.scope,
    sub: args.did,
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  })
}

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
