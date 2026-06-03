// OAuth tokens vs the XRPC dispatcher — end-to-end.
//
// The OAuth front-half test (oauth-front-half.test.ts) covers PAR → authorize
// → token. This follow-on test picks up where that left off: now that the
// client has a DPoP-bound access token, hit a real XRPC endpoint with
// `Authorization: DPoP <jwt>` + `DPoP: <proof>` and confirm the dispatcher
// authenticates the caller.
//
// `com.atproto.server.getSession` is the demonstration endpoint — it's the
// first handler migrated to `requireEitherAuth`, so it accepts both the
// legacy session JWT and the OAuth scheme.

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()
process.env.PDS_OAUTH_SIGNING_KEY ??=
  '3333333333333333333333333333333333333333333333333333333333333333'

import {
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint,
} from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

import { createAccount } from '~/pds/account/create'
import { signDpopProof, _resetDpopJtiCache } from '~/pds/oauth/dpop'
import { _resetClientMetadataCache } from '~/pds/oauth/clients'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

import { Route as parRoute } from '~/routes/oauth/par'
import { Route as authorizeRoute } from '~/routes/oauth/authorize'
import { Route as tokenRoute } from '~/routes/oauth/token'

type Ctx = { request: Request; params?: Record<string, string> }
function makeHandler<K extends 'GET' | 'POST'>(
  route: typeof parRoute | typeof authorizeRoute | typeof tokenRoute,
  method: K,
): (ctx: Ctx) => Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = (route as any).options ?? route
  const handlers = opts.server?.handlers ?? opts.handlers
  const fn = handlers[method]
  if (!fn) throw new Error(`route has no ${method} handler`)
  return fn as (ctx: Ctx) => Promise<Response>
}

const parPost = makeHandler(parRoute, 'POST')
const authorizeGet = makeHandler(authorizeRoute, 'GET')
const authorizePost = makeHandler(authorizeRoute, 'POST')
const tokenPost = makeHandler(tokenRoute, 'POST')

const PUBLIC_URL = 'http://localhost:3000'
const CLIENT_ID = `${PUBLIC_URL}/dev-client.json`
const REDIRECT_URI = `${PUBLIC_URL}/dev-client/callback`

const CLIENT_METADATA = {
  client_id: CLIENT_ID,
  client_name: 'XRPC-access test client',
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'atproto transition:generic',
  token_endpoint_auth_method: 'none',
  application_type: 'web',
  dpop_bound_access_tokens: true,
}

const origFetch = globalThis.fetch
beforeAll(async () => {
  await migrateProcessDb()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url === CLIENT_ID) {
      return new Response(JSON.stringify(CLIENT_METADATA), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return origFetch(input as RequestInfo, init)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = origFetch
  _resetClientMetadataCache()
})

describe('OAuth access token vs XRPC dispatcher (getSession)', () => {
  const handle = `oauth-xrpc-${Date.now()}.example.com`
  const email = `oauth-xrpc-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string
  // The minted credential pair used by every case below. Built in beforeAll
  // so we don't repeat the four-step front-half dance per case.
  let accessJwt: string
  let dpopPrivateKey: Awaited<
    ReturnType<typeof generateKeyPair>
  >['privateKey']
  let dpopPublicJwk: Awaited<ReturnType<typeof exportJWK>>

  beforeAll(async () => {
    const acct = await createAccount({ handle, email, password })
    did = acct.did
    _resetDpopJtiCache()

    // ── PAR → authorize → token: mint an OAuth access token. ─────────────
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    dpopPrivateKey = privateKey
    dpopPublicJwk = await exportJWK(publicKey)
    const dpopJkt = await calculateJwkThumbprint(dpopPublicJwk, 'sha256')

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('base64url')

    const parRes = await parPost({
      request: new Request(`${PUBLIC_URL}/oauth/par`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          scope: 'atproto transition:generic',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          dpop_jkt: dpopJkt,
          login_hint: handle,
        }),
      }),
    })
    expect(parRes.status).toBe(201)
    const { request_uri } = (await parRes.json()) as { request_uri: string }

    // Authorize GET to harvest the CSRF cookie.
    const authGetRes = await authorizeGet({
      request: new Request(
        `${PUBLIC_URL}/oauth/authorize?request_uri=${encodeURIComponent(request_uri)}`,
        { method: 'GET' },
      ),
    })
    const setCookie = authGetRes.headers.get('set-cookie') ?? ''
    const csrf = /oauth_csrf=([^;]+)/.exec(setCookie)![1]!

    // Authorize POST — sign in, redirect with code.
    const authPostRes = await authorizePost({
      request: new Request(
        `${PUBLIC_URL}/oauth/authorize?request_uri=${encodeURIComponent(request_uri)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `oauth_csrf=${csrf}`,
          },
          body: new URLSearchParams({ handle, password, csrf }).toString(),
        },
      ),
    })
    expect(authPostRes.status).toBe(302)
    const location = new URL(authPostRes.headers.get('location')!)
    const code = location.searchParams.get('code')!

    // Token POST.
    const tokenUrl = `${PUBLIC_URL}/oauth/token`
    const tokenProof = await signDpopProof({
      publicJwk: dpopPublicJwk,
      privateKey: dpopPrivateKey,
      alg: 'ES256',
      httpMethod: 'POST',
      httpUri: tokenUrl,
    })
    const tokRes = await tokenPost({
      request: new Request(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: tokenProof,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }).toString(),
      }),
    })
    expect(tokRes.status).toBe(200)
    const tokBody = (await tokRes.json()) as { access_token: string }
    accessJwt = tokBody.access_token
  })

  // Helper — build an XRPC GET Request for getSession with the right pair.
  function xrpcRequest(opts: {
    accessJwt?: string
    proof?: string
  }): Request {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.server.getSession`
    const headers: Record<string, string> = {}
    if (opts.accessJwt) headers['authorization'] = `DPoP ${opts.accessJwt}`
    if (opts.proof) headers['dpop'] = opts.proof
    return new Request(url, { method: 'GET', headers })
  }

  async function callGetSession(req: Request): Promise<{
    status: number
    body: unknown
  }> {
    const res = await dispatch(
      registry,
      'com.atproto.server.getSession',
      req,
    )
    const text = await res.text()
    let body: unknown = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { status: res.status, body }
  }

  it('accepts a fresh OAuth access + proof, returns the account', async () => {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.server.getSession`
    const proof = await signDpopProof({
      publicJwk: dpopPublicJwk,
      privateKey: dpopPrivateKey,
      alg: 'ES256',
      httpMethod: 'GET',
      httpUri: url,
    })
    const { status, body } = await callGetSession(
      xrpcRequest({ accessJwt, proof }),
    )
    expect(status).toBe(200)
    const out = body as {
      did: string
      handle: string
      email: string
      active: boolean
    }
    expect(out.did).toBe(did)
    expect(out.handle).toBe(handle)
    expect(out.email).toBe(email)
    expect(out.active).toBe(true)
  })

  it('rejects a replayed proof on the same request', async () => {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.server.getSession`
    const proof = await signDpopProof({
      publicJwk: dpopPublicJwk,
      privateKey: dpopPrivateKey,
      alg: 'ES256',
      httpMethod: 'GET',
      httpUri: url,
    })
    // First call: accept.
    const first = await callGetSession(xrpcRequest({ accessJwt, proof }))
    expect(first.status).toBe(200)
    // Second call with the same proof: jti is now in the replay cache.
    const second = await callGetSession(xrpcRequest({ accessJwt, proof }))
    expect(second.status).toBe(401)
    expect((second.body as { error: string }).error).toBe('InvalidToken')
  })

  it('rejects a tampered access token', async () => {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.server.getSession`
    const proof = await signDpopProof({
      publicJwk: dpopPublicJwk,
      privateKey: dpopPrivateKey,
      alg: 'ES256',
      httpMethod: 'GET',
      httpUri: url,
    })
    // Flip a byte in the payload segment of the JWT. The signature won't
    // verify so jwtVerify throws and the middleware returns InvalidToken.
    const parts = accessJwt.split('.')
    const payload = parts[1]!
    const tampered = `${parts[0]}.${payload.slice(0, -2)}xx.${parts[2]}`
    const { status, body } = await callGetSession(
      xrpcRequest({ accessJwt: tampered, proof }),
    )
    expect(status).toBe(401)
    expect((body as { error: string }).error).toBe('InvalidToken')
  })

  it('rejects a proof whose htm does not match the live request', async () => {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.server.getSession`
    // Proof signed for POST; dispatcher serves the GET.
    const proof = await signDpopProof({
      publicJwk: dpopPublicJwk,
      privateKey: dpopPrivateKey,
      alg: 'ES256',
      httpMethod: 'POST',
      httpUri: url,
    })
    const { status, body } = await callGetSession(
      xrpcRequest({ accessJwt, proof }),
    )
    expect(status).toBe(401)
    expect((body as { error: string }).error).toBe('InvalidToken')
  })
})
