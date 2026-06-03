// Unit tests for the small parts of proxy.ts that don't need a live
// upstream: header parsing, DID-document → endpoint resolution, JWT
// shape. The end-to-end forward+sign+verify path is covered by the
// integration test at `tests/integration/proxy.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeJwt, jwtVerify, importJWK } from 'jose'
import { secp256k1 } from '@noble/curves/secp256k1'

import {
  mintProxyServiceAuth,
  parseProxyHeader,
  resolveProxyEndpoint,
} from './proxy'

describe('parseProxyHeader', () => {
  it('parses did:web with a fragment', () => {
    expect(parseProxyHeader('did:web:api.bsky.app#bsky_appview')).toEqual({
      did: 'did:web:api.bsky.app',
      serviceId: 'bsky_appview',
    })
  })

  it('parses did:plc with a fragment', () => {
    expect(parseProxyHeader('did:plc:abc123#atproto_pds')).toEqual({
      did: 'did:plc:abc123',
      serviceId: 'atproto_pds',
    })
  })

  it('rejects values without a fragment', () => {
    expect(parseProxyHeader('did:web:api.bsky.app')).toBeNull()
  })

  it('rejects a trailing hash with no serviceId', () => {
    expect(parseProxyHeader('did:web:api.bsky.app#')).toBeNull()
  })

  it('rejects values that do not start with did:', () => {
    expect(parseProxyHeader('https://api.bsky.app#bsky_appview')).toBeNull()
  })

  it('rejects a leading hash (would yield an empty DID)', () => {
    expect(parseProxyHeader('#bsky_appview')).toBeNull()
  })
})

describe('resolveProxyEndpoint', () => {
  // We mock the resolver per-test rather than touching plc.directory / DNS.
  const RESOLVER = '~/pds/did/resolver'

  afterEach(() => vi.restoreAllMocks())

  async function withMockedDoc(
    doc: { service: { id: string; type: string; serviceEndpoint: string }[] } | null,
    fn: () => Promise<void>,
  ) {
    const mod = await import(RESOLVER)
    vi.spyOn(mod, 'resolveDid').mockResolvedValue(doc as never)
    await fn()
  }

  it('returns the matching service endpoint (relative #id form)', async () => {
    await withMockedDoc(
      {
        service: [
          {
            id: '#bsky_appview',
            type: 'BskyAppView',
            serviceEndpoint: 'https://api.bsky.app',
          },
        ],
      },
      async () => {
        const out = await resolveProxyEndpoint(
          'did:web:api.bsky.app',
          'bsky_appview',
        )
        expect(out).toBe('https://api.bsky.app')
      },
    )
  })

  it('returns the matching service endpoint (absolute did#id form)', async () => {
    await withMockedDoc(
      {
        service: [
          {
            id: 'did:web:api.bsky.app#bsky_appview',
            type: 'BskyAppView',
            serviceEndpoint: 'https://api.bsky.app',
          },
        ],
      },
      async () => {
        const out = await resolveProxyEndpoint(
          'did:web:api.bsky.app',
          'bsky_appview',
        )
        expect(out).toBe('https://api.bsky.app')
      },
    )
  })

  it('returns null when no service matches', async () => {
    await withMockedDoc(
      {
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example',
          },
        ],
      },
      async () => {
        expect(
          await resolveProxyEndpoint('did:web:api.bsky.app', 'bsky_appview'),
        ).toBeNull()
      },
    )
  })

  it('returns null when the DID document is missing', async () => {
    await withMockedDoc(null, async () => {
      expect(
        await resolveProxyEndpoint('did:web:nope.example', 'bsky_appview'),
      ).toBeNull()
    })
  })

  it('rejects a non-http(s) serviceEndpoint (so http://localhost… proxy attempts fail closed)', async () => {
    await withMockedDoc(
      {
        service: [
          {
            id: '#bsky_appview',
            type: 'BskyAppView',
            serviceEndpoint: 'ipfs://something',
          },
        ],
      },
      async () => {
        expect(
          await resolveProxyEndpoint('did:web:api.bsky.app', 'bsky_appview'),
        ).toBeNull()
      },
    )
  })
})

describe('mintProxyServiceAuth', () => {
  // Generate a k256 keypair we can both sign with and verify against. No
  // need to involve the DB or env — the function is pure given its inputs.
  function makeKeypair() {
    const priv = secp256k1.utils.randomPrivateKey()
    const privHex = Buffer.from(priv).toString('hex')
    const pub = secp256k1.getPublicKey(priv, false)
    const publicJwk = {
      kty: 'EC' as const,
      crv: 'secp256k1' as const,
      x: Buffer.from(pub.slice(1, 33)).toString('base64url'),
      y: Buffer.from(pub.slice(33, 65)).toString('base64url'),
      alg: 'ES256K' as const,
      use: 'sig' as const,
    }
    return { privHex, publicJwk }
  }

  it('mints a JWT with the expected claims', async () => {
    const { privHex } = makeKeypair()
    const jwt = await mintProxyServiceAuth({
      requesterDid: 'did:plc:abc',
      signingKeyPriv: privHex,
      audience: 'did:web:api.bsky.app',
      lxm: 'app.bsky.actor.getProfile',
    })
    const claims = decodeJwt(jwt)
    expect(claims.iss).toBe('did:plc:abc')
    expect(claims.aud).toBe('did:web:api.bsky.app')
    expect(claims.lxm).toBe('app.bsky.actor.getProfile')
    expect(typeof claims.jti).toBe('string')
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(60)
  })

  it('is verifiable with the matching public key (ES256K)', async () => {
    const { privHex, publicJwk } = makeKeypair()
    const jwt = await mintProxyServiceAuth({
      requesterDid: 'did:plc:abc',
      signingKeyPriv: privHex,
      audience: 'did:web:api.bsky.app',
      lxm: 'app.bsky.actor.getProfile',
    })
    const pubKey = await importJWK(publicJwk, 'ES256K')
    const { payload } = await jwtVerify(jwt, pubKey, {
      issuer: 'did:plc:abc',
      audience: 'did:web:api.bsky.app',
    })
    expect(payload.lxm).toBe('app.bsky.actor.getProfile')
  })

  it('fails verification when signed with the wrong key', async () => {
    const a = makeKeypair()
    const b = makeKeypair()
    const jwt = await mintProxyServiceAuth({
      requesterDid: 'did:plc:abc',
      signingKeyPriv: a.privHex,
      audience: 'did:web:api.bsky.app',
      lxm: 'app.bsky.actor.getProfile',
    })
    const wrongKey = await importJWK(b.publicJwk, 'ES256K')
    await expect(jwtVerify(jwt, wrongKey)).rejects.toThrow()
  })
})
