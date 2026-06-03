// Unit tests for the browser XRPC client.
//
// Same trick as session.test.ts: stub `globalThis.window` so the session
// helpers think they're in a browser, then mock `fetch` to drive the
// request/response cycle. The interesting cases are the refresh-on-401
// loop and the error-shape parsing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function installWindowStub(): void {
  const store = new Map<string, string>()
  ;(globalThis as unknown as { window: unknown }).window = {
    location: { origin: 'http://localhost:3000' },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
      removeItem: (k: string) => {
        store.delete(k)
      },
    },
  }
}

function uninstallWindowStub(): void {
  delete (globalThis as unknown as { window?: unknown }).window
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('xrpcCall', () => {
  beforeEach(() => {
    installWindowStub()
    vi.resetModules()
  })

  afterEach(() => {
    uninstallWindowStub()
    vi.restoreAllMocks()
  })

  it('GETs with query params and returns parsed JSON', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { records: [] }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy
    const { xrpcCall } = await import('./xrpc')
    const out = await xrpcCall<{ records: unknown[] }>(
      'com.atproto.repo.listRecords',
      { params: { repo: 'did:plc:x', collection: 'app.bsky.feed.post', limit: 50 } },
    )
    expect(out).toEqual({ records: [] })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('/xrpc/com.atproto.repo.listRecords')
    expect(String(url)).toContain('repo=did%3Aplc%3Ax')
    expect(String(url)).toContain('limit=50')
    expect((init as RequestInit).method).toBe('GET')
  })

  it('POSTs JSON when input is provided', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { did: 'did:plc:abc', handle: 'alice.test', accessJwt: 'a', refreshJwt: 'r' }),
      )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy
    const { xrpcCall } = await import('./xrpc')
    await xrpcCall('com.atproto.server.createSession', {
      input: { identifier: 'alice.test', password: 'hunter2' },
    })
    const [, init] = fetchSpy.mock.calls[0]!
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ identifier: 'alice.test', password: 'hunter2' }),
    )
    expect((init as RequestInit).headers).toEqual({
      'content-type': 'application/json',
    })
  })

  it('attaches the Authorization header when auth: true', async () => {
    const { setSession } = await import('./session')
    setSession({
      did: 'did:plc:x',
      handle: 'a.test',
      accessJwt: 'access-1',
      refreshJwt: 'refresh-1',
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy
    const { xrpcCall } = await import('./xrpc')
    await xrpcCall('com.atproto.server.getSession', { auth: true })
    const [, init] = fetchSpy.mock.calls[0]!
    expect((init as RequestInit).headers).toEqual({
      authorization: 'Bearer access-1',
    })
  })

  it('throws XrpcError carrying the upstream error code', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, { error: 'InvalidRequest', message: 'bad' }),
      )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy
    const { xrpcCall, XrpcError } = await import('./xrpc')
    await expect(
      xrpcCall('com.atproto.repo.createRecord', { input: { repo: 'x', collection: 'y', record: {} } }),
    ).rejects.toMatchObject({
      // can't `toBeInstanceOf(XrpcError)` from a freshly-imported module ref
      // because the class identity is preserved across resetModules.
      name: 'XrpcError',
      status: 400,
      errorCode: 'InvalidRequest',
      message: 'bad',
    })
    // Silence the unused-import lint
    expect(typeof XrpcError).toBe('function')
  })

  it('refreshes the session and replays once on ExpiredToken', async () => {
    const { setSession, getSession } = await import('./session')
    setSession({
      did: 'did:plc:x',
      handle: 'a.test',
      accessJwt: 'expired',
      refreshJwt: 'refresh-1',
    })

    const fetchSpy = vi
      .fn()
      // 1) the initial call — expired
      .mockResolvedValueOnce(
        jsonResponse(401, { error: 'ExpiredToken', message: 'expired' }),
      )
      // 2) refreshSession — fresh pair
      .mockResolvedValueOnce(
        jsonResponse(200, {
          did: 'did:plc:x',
          handle: 'a.test',
          accessJwt: 'access-2',
          refreshJwt: 'refresh-2',
        }),
      )
      // 3) replay of the original call — success
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy

    const { xrpcCall } = await import('./xrpc')
    const out = await xrpcCall<{ ok: boolean }>('com.atproto.server.getSession', {
      auth: true,
    })
    expect(out).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    // Session was rotated in storage.
    expect(getSession()).toEqual({
      did: 'did:plc:x',
      handle: 'a.test',
      accessJwt: 'access-2',
      refreshJwt: 'refresh-2',
    })
    // Replayed call used the new access token.
    const replayInit = fetchSpy.mock.calls[2]![1] as RequestInit
    expect(replayInit.headers).toEqual({ authorization: 'Bearer access-2' })
  })

  it('clears the session and throws when refresh itself fails', async () => {
    const { setSession, getSession } = await import('./session')
    setSession({
      did: 'did:plc:x',
      handle: 'a.test',
      accessJwt: 'expired',
      refreshJwt: 'dead',
    })

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(401, { error: 'ExpiredToken', message: 'expired' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(401, { error: 'ExpiredToken', message: 'refresh dead' }),
      )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy

    const { xrpcCall } = await import('./xrpc')
    await expect(
      xrpcCall('com.atproto.server.getSession', { auth: true }),
    ).rejects.toMatchObject({ status: 401, errorCode: 'ExpiredToken' })
    expect(getSession()).toBeNull()
  })

  it('returns undefined on 204 No Content', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy
    const { xrpcCall } = await import('./xrpc')
    const out = await xrpcCall('com.atproto.server.deleteSession')
    expect(out).toBeUndefined()
  })
})
