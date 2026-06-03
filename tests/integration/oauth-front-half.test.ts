// OAuth front-half end-to-end: /oauth/par → /oauth/authorize → /oauth/token.
//
// We drive the route handlers directly (no HTTP server stand-up) — they're
// plain `(request: Request) => Promise<Response>` functions courtesy of
// TanStack Start's `server.handlers` shape. Client-metadata fetch is
// monkey-patched on globalThis.fetch since we don't want to depend on a
// real client_id URL being reachable from CI.

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()
// PDS_OAUTH_SIGNING_KEY needs to be set BEFORE anything imports config.
process.env.PDS_OAUTH_SIGNING_KEY ??=
  '1111111111111111111111111111111111111111111111111111111111111111'

import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint,
} from 'jose'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

import { db } from '~/lib/db'
import { oauthCodes, oauthPar } from '~/lib/db/schema/oauth'
import { createAccount } from '~/pds/account/create'
import { _resetDpopJtiCache } from '~/pds/oauth/dpop'
import { _resetClientMetadataCache } from '~/pds/oauth/clients'

import { Route as parRoute } from '~/routes/oauth/par'
import { Route as authorizeRoute } from '~/routes/oauth/authorize'
import { Route as tokenRoute } from '~/routes/oauth/token'

// The route module exposes its handlers under .options.server.handlers;
// in real TanStack Start they're invoked by the framework with a context
// arg ({ request, params }). We bypass the framework and call them
// directly.
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
  client_name: 'Dev test client',
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
  // Intercept client-metadata fetches so the test doesn't hit the network.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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

describe('OAuth front half: PAR → authorize → token', () => {
  const handle = `oauth-${Date.now()}.example.com`
  const email = `oauth-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string

  beforeAll(async () => {
    const acct = await createAccount({ handle, email, password })
    did = acct.did
    _resetDpopJtiCache()
  })

  it('end-to-end: PAR pushes, authorize logs in, token redeems', async () => {
    // ── 0. Client-side: DPoP keypair + PKCE pair ────────────────────────────
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    const dpopJwk = await exportJWK(publicKey)
    const dpopJkt = await calculateJwkThumbprint(dpopJwk, 'sha256')

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('base64url')

    // ── 1. POST /oauth/par ──────────────────────────────────────────────────
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
    const parBody = (await parRes.json()) as {
      request_uri: string
      expires_in: number
    }
    expect(parBody.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/)
    expect(parBody.expires_in).toBe(60)

    // The PAR row should exist.
    const parRows = await db
      .select()
      .from(oauthPar)
      .where(eq(oauthPar.requestUri, parBody.request_uri))
    expect(parRows).toHaveLength(1)
    expect(parRows[0]!.dpopJkt).toBe(dpopJkt)

    // ── 2. GET /oauth/authorize?request_uri=... ────────────────────────────
    const authorizeGetRes = await authorizeGet({
      request: new Request(
        `${PUBLIC_URL}/oauth/authorize?request_uri=${encodeURIComponent(parBody.request_uri)}`,
        { method: 'GET' },
      ),
    })
    expect(authorizeGetRes.status).toBe(200)
    expect(authorizeGetRes.headers.get('content-type')).toContain('text/html')
    const html = await authorizeGetRes.text()
    expect(html).toContain('Authorize')
    expect(html).toContain(CLIENT_ID)
    // Login hint pre-fills the handle field.
    expect(html).toContain(`value="${handle}"`)
    // CSRF cookie was set.
    const setCookie = authorizeGetRes.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/^oauth_csrf=([^;]+)/)
    const csrfMatch = /oauth_csrf=([^;]+)/.exec(setCookie)
    const csrf = csrfMatch![1]!
    // The same value is in the hidden form field.
    expect(html).toContain(`value="${csrf}"`)

    // ── 3. POST /oauth/authorize with handle + password + csrf ─────────────
    const formBody = new URLSearchParams({
      handle,
      password,
      csrf,
    })
    const authorizePostRes = await authorizePost({
      request: new Request(
        `${PUBLIC_URL}/oauth/authorize?request_uri=${encodeURIComponent(parBody.request_uri)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `oauth_csrf=${csrf}`,
          },
          body: formBody.toString(),
        },
      ),
    })
    expect(authorizePostRes.status).toBe(302)
    const location = authorizePostRes.headers.get('location')
    expect(location).toBeTruthy()
    const locUrl = new URL(location!)
    expect(`${locUrl.protocol}//${locUrl.host}${locUrl.pathname}`).toBe(REDIRECT_URI)
    const code = locUrl.searchParams.get('code')
    expect(code).toBeTruthy()
    expect(locUrl.searchParams.get('state')).toBe(state)
    expect(locUrl.searchParams.get('iss')).toBe(PUBLIC_URL)

    // PAR row should be deleted; codes row should exist.
    const parAfter = await db
      .select()
      .from(oauthPar)
      .where(eq(oauthPar.requestUri, parBody.request_uri))
    expect(parAfter).toHaveLength(0)
    const codeRows = await db
      .select()
      .from(oauthCodes)
      .where(eq(oauthCodes.code, code!))
    expect(codeRows).toHaveLength(1)
    expect(codeRows[0]!.did).toBe(did)
    expect(codeRows[0]!.dpopJkt).toBe(dpopJkt)
    expect(codeRows[0]!.used).toBe(false)

    // ── 4. POST /oauth/token with grant_type=authorization_code ────────────
    const dpopProof = async (method: string, url: string): Promise<string> =>
      new SignJWT({ htm: method, htu: url, jti: randomBytes(8).toString('base64url') })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopJwk })
        .setIssuedAt()
        .sign(privateKey)

    const tokenUrl = `${PUBLIC_URL}/oauth/token`
    const tokenRes = await tokenPost({
      request: new Request(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: await dpopProof('POST', tokenUrl),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }).toString(),
      }),
    })
    expect(tokenRes.status).toBe(200)
    const tokenBody = (await tokenRes.json()) as {
      access_token: string
      refresh_token: string
      token_type: string
      expires_in: number
      scope: string
      sub: string
    }
    expect(tokenBody.token_type).toBe('DPoP')
    expect(tokenBody.sub).toBe(did)
    expect(tokenBody.scope).toBe('atproto transition:generic')
    expect(tokenBody.access_token.split('.')).toHaveLength(3)
    expect(tokenBody.refresh_token.split('.')).toHaveLength(3)
    expect(tokenBody.expires_in).toBeGreaterThan(0)

    // Code is now flagged used.
    const codeAfter = await db
      .select()
      .from(oauthCodes)
      .where(eq(oauthCodes.code, code!))
    expect(codeAfter[0]!.used).toBe(true)

    // ── 5. Replay attempt: same code, same proof — should fail ─────────────
    const replay = await tokenPost({
      request: new Request(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: await dpopProof('POST', tokenUrl),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }).toString(),
      }),
    })
    expect(replay.status).toBe(400)
    const replayBody = (await replay.json()) as { error: string }
    expect(replayBody.error).toBe('invalid_grant')
  })

  it('PAR rejects when redirect_uri is not in client metadata', async () => {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const res = await parPost({
      request: new Request(`${PUBLIC_URL}/oauth/par`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: 'http://evil.example.com/callback',
          scope: 'atproto',
          state: 'xyz',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          dpop_jkt: 'ignored-for-this-test',
        }),
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_request')
  })

  it('authorize POST rejects wrong CSRF', async () => {
    // Push a fresh PAR row first.
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const parRes = await parPost({
      request: new Request(`${PUBLIC_URL}/oauth/par`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          scope: 'atproto',
          state: 'abc',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          dpop_jkt: 'csrf-test-jkt',
        }),
      }),
    })
    const { request_uri } = (await parRes.json()) as { request_uri: string }

    const postRes = await authorizePost({
      request: new Request(
        `${PUBLIC_URL}/oauth/authorize?request_uri=${encodeURIComponent(request_uri)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: 'oauth_csrf=cookieside',
          },
          body: new URLSearchParams({
            handle,
            password,
            csrf: 'formside', // mismatch
          }).toString(),
        },
      ),
    })
    expect(postRes.status).toBe(400)
    expect(await postRes.text()).toContain('CSRF')
  })
})
