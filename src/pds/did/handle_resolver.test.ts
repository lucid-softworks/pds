// Tests for the cross-PDS handle resolver.
//
// We don't reach real DNS or HTTP here — the unit-level value is in
// asserting the parsing + bidirectional-check logic. The end-to-end DNS
// path is exercised by hand in production; the chapter walks the curl
// recipe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<typeof globalThis.fetch>()
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

const dnsResolveTxtMock = vi.fn<(name: string) => Promise<string[][]>>()
vi.mock('node:dns/promises', () => ({
  resolveTxt: (...args: [string]) => dnsResolveTxtMock(...args),
}))

const resolveDidMock = vi.fn<(did: string) => Promise<unknown>>()
vi.mock('~/pds/did/external_resolver', () => ({
  resolveDid: (...args: [string]) => resolveDidMock(...args),
  resetResolverCache: () => {},
}))

import {
  resolveHandleExternal,
  resolveHandleViaDns,
  resolveHandleViaWellKnown,
  resetHandleCache,
} from './handle_resolver'

const did = 'did:plc:abcd1234abcd1234abcd1234'

beforeEach(() => {
  fetchMock.mockReset()
  dnsResolveTxtMock.mockReset()
  resolveDidMock.mockReset()
  resetHandleCache()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveHandleViaDns', () => {
  it('parses did= from a single TXT record', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([[`did=${did}`]])
    expect(await resolveHandleViaDns('alice.example.com')).toBe(did)
    expect(dnsResolveTxtMock).toHaveBeenCalledWith('_atproto.alice.example.com')
  })

  it('handles multi-chunk TXT (DNS allows up to 255-byte chunks per record)', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([['did=', did]])
    expect(await resolveHandleViaDns('alice.example.com')).toBe(did)
  })

  it('ignores TXT records that do not start with did=', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([
      ['v=spf1 -all'],
      [`did=${did}`],
    ])
    expect(await resolveHandleViaDns('alice.example.com')).toBe(did)
  })

  it('returns null when no TXT record matches', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([['v=spf1 -all']])
    expect(await resolveHandleViaDns('alice.example.com')).toBeNull()
  })

  it('returns null on NXDOMAIN / network errors', async () => {
    dnsResolveTxtMock.mockRejectedValueOnce(new Error('ENOTFOUND'))
    expect(await resolveHandleViaDns('alice.example.com')).toBeNull()
  })

  it('returns null on a malformed DID string', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([['did=not_a_did']])
    expect(await resolveHandleViaDns('alice.example.com')).toBeNull()
  })
})

describe('resolveHandleViaWellKnown', () => {
  it('returns the body of a 200 response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(did, { status: 200 }),
    )
    expect(await resolveHandleViaWellKnown('alice.example.com')).toBe(did)
    const url = fetchMock.mock.calls[0]![0]
    expect(String(url)).toBe('https://alice.example.com/.well-known/atproto-did')
  })

  it('returns null on non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    expect(await resolveHandleViaWellKnown('alice.example.com')).toBeNull()
  })

  it('returns null on a malformed body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('hello world', { status: 200 }))
    expect(await resolveHandleViaWellKnown('alice.example.com')).toBeNull()
  })

  it('returns null on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'))
    expect(await resolveHandleViaWellKnown('alice.example.com')).toBeNull()
  })

  it('trims surrounding whitespace from the body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`  ${did}\n`, { status: 200 }))
    expect(await resolveHandleViaWellKnown('alice.example.com')).toBe(did)
  })
})

describe('resolveHandleExternal', () => {
  it('returns null for malformed handles without hitting the network', async () => {
    expect(await resolveHandleExternal('NOT A HANDLE')).toBeNull()
    expect(dnsResolveTxtMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a DNS answer + valid bidirectional alsoKnownAs', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([[`did=${did}`]])
    fetchMock.mockRejectedValueOnce(new Error('skip'))
    resolveDidMock.mockResolvedValueOnce({
      id: did,
      alsoKnownAs: ['at://alice.example.com'],
    })
    expect(await resolveHandleExternal('alice.example.com')).toBe(did)
  })

  it('rejects an answer when the DID document does not claim the handle', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([[`did=${did}`]])
    fetchMock.mockRejectedValueOnce(new Error('skip'))
    resolveDidMock.mockResolvedValueOnce({
      id: did,
      alsoKnownAs: ['at://someone.else.com'],
    })
    expect(await resolveHandleExternal('alice.example.com')).toBeNull()
  })

  it('caches positive results — second call does not hit the network', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([[`did=${did}`]])
    fetchMock.mockRejectedValueOnce(new Error('skip'))
    resolveDidMock.mockResolvedValueOnce({
      id: did,
      alsoKnownAs: ['at://alice.example.com'],
    })
    expect(await resolveHandleExternal('alice.example.com')).toBe(did)

    // Second call: no new network mocks set; everything should come from cache.
    expect(await resolveHandleExternal('alice.example.com')).toBe(did)
    expect(dnsResolveTxtMock).toHaveBeenCalledTimes(1)
  })

  it('caches negative results too', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([])
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    expect(await resolveHandleExternal('alice.example.com')).toBeNull()
    expect(await resolveHandleExternal('alice.example.com')).toBeNull()
    expect(dnsResolveTxtMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls through to well-known when DNS has no answer', async () => {
    dnsResolveTxtMock.mockResolvedValueOnce([])
    fetchMock.mockResolvedValueOnce(new Response(did, { status: 200 }))
    resolveDidMock.mockResolvedValueOnce({
      id: did,
      alsoKnownAs: ['at://alice.example.com'],
    })
    expect(await resolveHandleExternal('alice.example.com')).toBe(did)
  })
})
