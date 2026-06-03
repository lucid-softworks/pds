// TanStack Start API route: POST /oauth/par
//
// RFC 9126 Pushed Authorization Requests. The OAuth client POSTs the
// full set of /oauth/authorize parameters here over the back channel and
// we hand back an opaque `request_uri` handle that the user-facing
// /oauth/authorize endpoint dereferences. Atproto OAuth mandates PAR for
// every flow — clients can't pass raw parameters on the front channel.
//
// Wire shape:
//   - Request body is either application/x-www-form-urlencoded or
//     application/json — clients have historically picked one or the other.
//   - DPoP header is *optional* on PAR per RFC 9449: confidential clients
//     would attach one, public clients (the only atproto client kind today)
//     usually skip it. If present we verify; if absent we still accept.
//   - Success: 201 with { request_uri, expires_in }.
//   - Failure: 4xx with { error, error_description } per RFC 6749.
//
// See chapter 21 — OAuth.

import { createFileRoute } from '@tanstack/react-router'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

import { db } from '~/lib/db'
import { oauthPar } from '~/lib/db/schema/oauth'
import { fetchClientMetadata } from '~/pds/oauth/clients'
import { verifyDpopProof } from '~/pds/oauth/dpop'

const PAR_TTL_SECONDS = 60

const InputSchema = z.object({
  client_id: z.string().url(),
  response_type: z.literal('code'),
  redirect_uri: z.string().url(),
  scope: z.string().min(1),
  state: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  dpop_jkt: z.string().min(1),
  login_hint: z.string().optional(),
})

export const Route = createFileRoute('/oauth/par')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const params = await readParams(request)
        if (!params) {
          return errorResponse(
            400,
            'invalid_request',
            'PAR body must be application/json or application/x-www-form-urlencoded',
          )
        }
        const parsed = InputSchema.safeParse(params)
        if (!parsed.success) {
          return errorResponse(
            400,
            'invalid_request',
            'invalid PAR parameters: ' +
              parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          )
        }

        // DPoP is optional on PAR. If present, verify and require the proof's
        // jkt to match the declared dpop_jkt — otherwise the client is lying
        // about which key they hold.
        const dpopHeader = request.headers.get('dpop')
        if (dpopHeader && dpopHeader.trim().length > 0) {
          try {
            const proof = await verifyDpopProof({
              dpopHeader,
              httpMethod: 'POST',
              httpUri: request.url,
            })
            if (proof.jkt !== parsed.data.dpop_jkt) {
              return errorResponse(
                400,
                'invalid_dpop_proof',
                `DPoP proof jkt does not match dpop_jkt parameter (proof=${proof.jkt})`,
              )
            }
          } catch (err) {
            return errorResponse(
              400,
              'invalid_dpop_proof',
              (err as Error).message,
            )
          }
        }

        // Validate client metadata + redirect_uri allowlist.
        let metadata
        try {
          metadata = await fetchClientMetadata(parsed.data.client_id)
        } catch (err) {
          return errorResponse(
            400,
            'invalid_client_metadata',
            (err as Error).message,
          )
        }
        if (!metadata.redirect_uris.includes(parsed.data.redirect_uri)) {
          return errorResponse(
            400,
            'invalid_request',
            'redirect_uri is not in the client metadata redirect_uris list',
          )
        }

        // Mint a request_uri and persist.
        const requestUri = mintRequestUri()
        const expiresAt = new Date(Date.now() + PAR_TTL_SECONDS * 1000)
        await db.insert(oauthPar).values({
          requestUri,
          clientId: parsed.data.client_id,
          redirectUri: parsed.data.redirect_uri,
          scope: parsed.data.scope,
          state: parsed.data.state,
          codeChallenge: parsed.data.code_challenge,
          codeChallengeMethod: parsed.data.code_challenge_method,
          dpopJkt: parsed.data.dpop_jkt,
          loginHint: parsed.data.login_hint ?? null,
          expiresAt,
        })

        return new Response(
          JSON.stringify({
            request_uri: requestUri,
            expires_in: PAR_TTL_SECONDS,
          }),
          {
            // RFC 9126 §2.2 — successful PAR responses use 201 Created.
            status: 201,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              pragma: 'no-cache',
            },
          },
        )
      },
    },
  },
})

async function readParams(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase()
  const body = await request.text()
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(body) as unknown
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
    return null
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body)
    const out: Record<string, unknown> = {}
    for (const [k, v] of params) out[k] = v
    return out
  }
  return null
}

function mintRequestUri(): string {
  // RFC 9126 — the request_uri SHOULD be unguessable and short-lived. The
  // urn:ietf:params:oauth:request_uri: prefix is the registered scheme.
  const random = randomBytes(32).toString('base64url')
  return `urn:ietf:params:oauth:request_uri:${random}`
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
