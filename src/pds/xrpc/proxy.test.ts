// Unit tests for the small parts of proxy.ts that don't need a live
// upstream: header parsing, DID-document → endpoint resolution, JWT
// shape. The end-to-end forward+sign+verify path is covered by the
// integration test at `tests/integration/proxy.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseProxyHeader, resolveProxyEndpoint } from './proxy'

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

// JWT shape / verification tests for the shared service-auth minter
// live in src/pds/auth/service_auth.test.ts. The proxy delegates to
// that minter and only needs to cover its own header-parse + endpoint-
// resolve logic here.
