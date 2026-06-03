// Integration test for the `Atproto-Proxy` header path:
//
//   client → PDS (verifies bearer) → mints ES256K service-auth (signed
//   with caller's repo key) → forwards to mock upstream → streams the
//   upstream's response back to the client unchanged.
//
// We stand up a real `http` server on 127.0.0.1 to play the role of the
// AppView, dispatch a real Request through the PDS dispatcher, and
// assert both halves: (a) the upstream received a request with the
// right URL, method, and a service-auth JWT we can verify against the
// caller's public key, and (b) the response coming back through the
// PDS matches what the upstream returned.

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { describe, beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { importJWK, jwtVerify } from 'jose'

import { createAccount } from '~/pds/account/create'
import { dispatch, HandlerRegistry } from '~/pds/xrpc/server'
import * as resolverMod from '~/pds/did/resolver'

describe('Atproto-Proxy forwarding', () => {
  let upstream: Server
  let upstreamUrl: string
  let lastUpstreamCall: {
    url: string
    method: string
    authorization: string | null
    body: string
  } | null = null

  beforeAll(async () => {
    await migrateProcessDb()

    upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        lastUpstreamCall = {
          url: req.url ?? '',
          method: req.method ?? '',
          authorization: req.headers['authorization'] ?? null,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.setHeader('x-upstream-marker', 'mock-appview')
        res.end(JSON.stringify({ ok: true, lxm: 'app.bsky.actor.getProfile' }))
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const addr = upstream.address() as AddressInfo
    upstreamUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    upstream.close()
  })

  beforeEach(() => {
    lastUpstreamCall = null
    vi.restoreAllMocks()
  })

  it('forwards an app.bsky.* call upstream with a verifiable service-auth JWT', async () => {
    const { did, accessJwt } = await createAccount({
      handle: 'alice.test',
      email: 'alice@example.com',
      password: 'correct-horse-battery-staple',
    })

    // The proxy resolver looks up the *target* DID (the AppView), not the
    // caller. We mock it to return our mock-upstream URL so the test
    // doesn't need network access.
    vi.spyOn(resolverMod, 'resolveDid').mockImplementation(async (did) => {
      if (did === 'did:web:mock-appview.test') {
        return {
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: did,
          alsoKnownAs: [],
          verificationMethod: [],
          service: [
            {
              id: '#bsky_appview',
              type: 'BskyAppView',
              serviceEndpoint: upstreamUrl,
            },
          ],
        } as never
      }
      return null
    })

    const request = new Request(
      'http://wickwork.cafe/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Asomeone',
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessJwt}`,
          'atproto-proxy': 'did:web:mock-appview.test#bsky_appview',
        },
      },
    )
    // Empty registry — the dispatcher must take the proxy branch instead
    // of looking up a local handler.
    const res = await dispatch(new HandlerRegistry(), 'app.bsky.actor.getProfile', request)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, lxm: 'app.bsky.actor.getProfile' })
    // Upstream headers (other than hop-by-hop) survive.
    expect(res.headers.get('x-upstream-marker')).toBe('mock-appview')

    // The mock upstream saw our forwarded request.
    expect(lastUpstreamCall).not.toBeNull()
    expect(lastUpstreamCall!.method).toBe('GET')
    expect(lastUpstreamCall!.url).toBe(
      '/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Asomeone',
    )

    // The service-auth JWT must be valid against the caller's repo
    // public key. The PDS issued one keypair when the account was
    // created; we reconstruct the public key from the stored hex.
    const auth = lastUpstreamCall!.authorization
    expect(auth).toMatch(/^Bearer /)
    const jwt = auth!.slice('Bearer '.length)

    const publicJwk = await callerPublicJwk(did)
    const pubKey = await importJWK(publicJwk, 'ES256K')
    const { payload, protectedHeader } = await jwtVerify(jwt, pubKey, {
      issuer: did,
      audience: 'did:web:mock-appview.test',
    })
    expect(protectedHeader.alg).toBe('ES256K')
    expect(payload.lxm).toBe('app.bsky.actor.getProfile')
    expect((payload.exp as number) - (payload.iat as number)).toBe(60)
  })

  it('returns 404-style error when the proxy target cannot be resolved', async () => {
    const { accessJwt } = await createAccount({
      handle: 'bob.test',
      email: 'bob@example.com',
      password: 'correct-horse-battery-staple',
    })

    vi.spyOn(resolverMod, 'resolveDid').mockResolvedValue(null)

    const request = new Request(
      'http://wickwork.cafe/xrpc/app.bsky.actor.getProfile',
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessJwt}`,
          'atproto-proxy': 'did:web:nobody.test#bsky_appview',
        },
      },
    )
    const res = await dispatch(new HandlerRegistry(), 'app.bsky.actor.getProfile', request)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('XrpcProxyTargetNotFound')
  })

  it('returns 401 when the proxy request has no bearer auth', async () => {
    vi.spyOn(resolverMod, 'resolveDid').mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:mock-appview.test',
      alsoKnownAs: [],
      verificationMethod: [],
      service: [
        {
          id: '#bsky_appview',
          type: 'BskyAppView',
          serviceEndpoint: upstreamUrl,
        },
      ],
    } as never)

    const request = new Request(
      'http://wickwork.cafe/xrpc/app.bsky.actor.getProfile',
      {
        method: 'GET',
        headers: {
          'atproto-proxy': 'did:web:mock-appview.test#bsky_appview',
        },
      },
    )
    const res = await dispatch(new HandlerRegistry(), 'app.bsky.actor.getProfile', request)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

/** Reconstruct the public JWK from the caller's stored (wrapped) signing
 *  key. We unwrap and derive the secp256k1 public point. */
async function callerPublicJwk(
  did: string,
): Promise<{ kty: 'EC'; crv: 'secp256k1'; x: string; y: string; alg: 'ES256K'; use: 'sig' }> {
  const { db } = await import('~/lib/db')
  const { accounts } = await import('~/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { getKeyWrapper } = await import('~/pds/auth/key_wrap')
  const { secp256k1 } = await import('@noble/curves/secp256k1')

  const row = (
    await db
      .select({ signingKeyPriv: accounts.signingKeyPriv })
      .from(accounts)
      .where(eq(accounts.did, did))
      .limit(1)
  )[0]
  if (!row) throw new Error(`no account row for ${did}`)
  const privHex = await getKeyWrapper().unwrap(row.signingKeyPriv)
  const privBytes = new Uint8Array(
    privHex.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16)),
  )
  const pub = secp256k1.getPublicKey(privBytes, false)
  return {
    kty: 'EC',
    crv: 'secp256k1',
    x: Buffer.from(pub.slice(1, 33)).toString('base64url'),
    y: Buffer.from(pub.slice(33, 65)).toString('base64url'),
    alg: 'ES256K',
    use: 'sig',
  }
}
