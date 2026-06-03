// Behaviour contract for the rate-limit store + policy lookup.
//
// Two halves: the in-memory token bucket (lots of edge cases — first hit,
// boundary refill, isolation between keys), and the policy table
// (the upstream PDS's approximate per-NSID limits, with `null` for the
// long tail).

import { afterEach, describe, expect, it } from 'vitest'

import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  callerIpFromRequest,
  rateLimitFor,
  _resetMissingXffWarning,
} from './rate_limit'

afterEach(() => {
  _resetMissingXffWarning()
})

describe('InMemoryRateLimitStore', () => {
  it('allows the first call within capacity', async () => {
    const now = { t: 0 }
    const store = new InMemoryRateLimitStore({ now: () => now.t })
    const limit = { capacity: 5, windowMs: 1000 }
    const r = await store.check('a:n', limit)
    expect(r.allowed).toBe(true)
    if (r.allowed) {
      expect(r.remaining).toBe(4)
      expect(r.resetAt).toBeGreaterThan(0)
    }
  })

  it('returns the right remaining count across N calls', async () => {
    const now = { t: 0 }
    const store = new InMemoryRateLimitStore({ now: () => now.t })
    const limit = { capacity: 3, windowMs: 1000 }
    const a = await store.check('k', limit)
    const b = await store.check('k', limit)
    const c = await store.check('k', limit)
    expect(a.allowed && a.remaining).toBe(2)
    expect(b.allowed && b.remaining).toBe(1)
    expect(c.allowed && c.remaining).toBe(0)
  })

  it('rejects with retryAfterMs > 0 after capacity is spent', async () => {
    const now = { t: 0 }
    const store = new InMemoryRateLimitStore({ now: () => now.t })
    const limit = { capacity: 2, windowMs: 1000 }
    await store.check('k', limit)
    await store.check('k', limit)
    const r = await store.check('k', limit)
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.retryAfterMs).toBeGreaterThan(0)
      // With a 2-per-1000ms bucket, the next token arrives in 500ms.
      expect(r.retryAfterMs).toBeLessThanOrEqual(500)
    }
  })

  it('refills tokens after the window elapses', async () => {
    const now = { t: 0 }
    const store = new InMemoryRateLimitStore({ now: () => now.t })
    const limit = { capacity: 2, windowMs: 1000 }
    await store.check('k', limit)
    await store.check('k', limit)
    const blocked = await store.check('k', limit)
    expect(blocked.allowed).toBe(false)

    // Advance past the full refill window.
    now.t = 2000
    const r = await store.check('k', limit)
    expect(r.allowed).toBe(true)
  })

  it('isolates different keys', async () => {
    const store = new InMemoryRateLimitStore({ now: () => 0 })
    const limit = { capacity: 1, windowMs: 1000 }
    const a = await store.check('alice:n', limit)
    const b = await store.check('bob:n', limit)
    expect(a.allowed).toBe(true)
    expect(b.allowed).toBe(true)
    // Each key independently exhausted.
    const aAgain = await store.check('alice:n', limit)
    expect(aAgain.allowed).toBe(false)
    const bAgain = await store.check('bob:n', limit)
    expect(bAgain.allowed).toBe(false)
  })
})

describe('RedisRateLimitStore', () => {
  it('throws — the teaching port ships a stub', async () => {
    const store = new RedisRateLimitStore()
    await expect(store.check('k', { capacity: 1, windowMs: 1 })).rejects.toThrow(
      /not implemented/,
    )
  })
})

describe('rateLimitFor', () => {
  it('returns the createSession limit', () => {
    const r = rateLimitFor('com.atproto.server.createSession', 'POST')
    expect(r).toEqual({ capacity: 30, windowMs: 5 * 60 * 1000 })
  })

  it('returns the createAccount per-day limit', () => {
    const r = rateLimitFor('com.atproto.server.createAccount', 'POST')
    expect(r).toEqual({ capacity: 100, windowMs: 24 * 60 * 60 * 1000 })
  })

  it('returns the requestPasswordReset 5-per-5min limit', () => {
    const r = rateLimitFor('com.atproto.server.requestPasswordReset', 'POST')
    expect(r).toEqual({ capacity: 5, windowMs: 5 * 60 * 1000 })
  })

  it('returns the uploadBlob hourly limit', () => {
    const r = rateLimitFor('com.atproto.repo.uploadBlob', 'POST')
    expect(r).toEqual({ capacity: 5000, windowMs: 60 * 60 * 1000 })
  })

  it('returns the createRecord hourly limit', () => {
    const r = rateLimitFor('com.atproto.repo.createRecord', 'POST')
    expect(r).toEqual({ capacity: 7000, windowMs: 60 * 60 * 1000 })
  })

  it('returns null for an unlisted NSID', () => {
    expect(rateLimitFor('com.atproto.repo.getRecord', 'GET')).toBeNull()
    expect(rateLimitFor('com.atproto.identity.resolveHandle', 'GET')).toBeNull()
    expect(rateLimitFor('app.bsky.feed.getTimeline', 'GET')).toBeNull()
  })
})

describe('callerIpFromRequest', () => {
  it('returns the first non-private hop from X-Forwarded-For', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    })
    expect(callerIpFromRequest(req)).toBe('203.0.113.5')
  })

  it('skips private hops in X-Forwarded-For', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1, 198.51.100.42' },
    })
    expect(callerIpFromRequest(req)).toBe('198.51.100.42')
  })

  it('falls back to X-Real-IP', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-real-ip': '203.0.113.99' },
    })
    expect(callerIpFromRequest(req)).toBe('203.0.113.99')
  })

  it("returns 'unknown' when no proxy header is set", () => {
    const req = new Request('http://localhost/')
    expect(callerIpFromRequest(req)).toBe('unknown')
  })
})
