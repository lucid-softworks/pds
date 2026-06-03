// Unit tests for the localStorage-backed session helpers.
//
// We can't import the real `window.localStorage` from node, so we stub a
// tiny in-memory `localStorage` polyfill on the globalThis.window before
// importing the module under test. Each test resets it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Stub = {
  store: Map<string, string>
}

function installWindowStub(): Stub {
  const store = new Map<string, string>()
  ;(globalThis as unknown as { window: unknown }).window = {
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
  return { store }
}

function uninstallWindowStub(): void {
  delete (globalThis as unknown as { window?: unknown }).window
}

describe('session', () => {
  let stub: Stub

  beforeEach(() => {
    stub = installWindowStub()
    vi.resetModules()
  })

  afterEach(() => {
    uninstallWindowStub()
    vi.restoreAllMocks()
  })

  it('getSession returns null when nothing is stored', async () => {
    const { getSession } = await import('./session')
    expect(getSession()).toBeNull()
  })

  it('setSession then getSession round-trips', async () => {
    const { getSession, setSession } = await import('./session')
    setSession({
      did: 'did:plc:abc',
      handle: 'alice.test',
      accessJwt: 'a',
      refreshJwt: 'r',
    })
    expect(getSession()).toEqual({
      did: 'did:plc:abc',
      handle: 'alice.test',
      accessJwt: 'a',
      refreshJwt: 'r',
    })
  })

  it('getSession returns null on corrupt JSON', async () => {
    const { getSession } = await import('./session')
    stub.store.set('pds.session', 'not-json')
    expect(getSession()).toBeNull()
  })

  it('getSession returns null when required fields are missing', async () => {
    const { getSession } = await import('./session')
    stub.store.set('pds.session', JSON.stringify({ did: 'did:plc:x' }))
    expect(getSession()).toBeNull()
  })

  it('clearSession removes the stored entry', async () => {
    const { clearSession, getSession, setSession } = await import('./session')
    setSession({
      did: 'did:plc:abc',
      handle: 'alice.test',
      accessJwt: 'a',
      refreshJwt: 'r',
    })
    clearSession()
    expect(getSession()).toBeNull()
  })

  it('logout clears local state even when the server call fails', async () => {
    const { getSession, logout, setSession } = await import('./session')
    setSession({
      did: 'did:plc:abc',
      handle: 'alice.test',
      accessJwt: 'a',
      refreshJwt: 'r',
    })
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network'))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy
    await logout()
    expect(getSession()).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith(
      '/xrpc/com.atproto.server.deleteSession',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer r' },
      }),
    )
  })

  it('logout is a no-op when no session is stored', async () => {
    const { logout } = await import('./session')
    const fetchSpy = vi.fn()
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy
    await logout()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
