// End-to-end rate limiter through the XRPC dispatcher.
//
// We stand up a throwaway handler registry (matching the metrics
// integration test's approach) and re-register `com.atproto.server.createSession`
// so the policy table lookup hits a real entry. Then we hammer it from
// one IP, watch the 31st request flip to 429 with a Retry-After header,
// and confirm that a *different* IP doing the same thing in parallel
// isn't affected.
//
// The rate-limit store is the process singleton. We reset it before
// each test so cases don't leak buckets.

import { setupTestDbEnv, migrateProcessDb } from '../db'
setupTestDbEnv()

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { dispatch, HandlerRegistry } from '~/pds/xrpc/server'
import {
  InMemoryRateLimitStore,
  _setRateLimitStoreForTests,
} from '~/pds/xrpc/rate_limit'
import { _resetMetricsForTests } from '~/lib/metrics'
import { handleMetrics } from '~/routes/metrics'

beforeAll(async () => {
  await migrateProcessDb()
  // Enable metrics so we can scrape pds_rate_limit_rejected_total below.
  process.env.PDS_METRICS = 'true'
})

beforeEach(() => {
  // Fresh in-memory bucket map between tests.
  _setRateLimitStoreForTests(new InMemoryRateLimitStore())
  _resetMetricsForTests()
})

function buildEchoRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('com.atproto.server.createSession', {
    method: 'POST',
    // Returns a session response shaped like the real handler so the
    // observe-only lexicon validator stays quiet in the test log.
    handler: async () => ({
      accessJwt: 'a.b.c',
      refreshJwt: 'a.b.c',
      did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      handle: 'a.test',
    }),
  })
  return registry
}

function postFromIp(ip: string): Request {
  return new Request(
    new URL('http://localhost/xrpc/com.atproto.server.createSession'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ identifier: 'a.test', password: 'x' }),
    },
  )
}

describe('rate limiter through dispatch()', () => {
  it('rejects the 31st createSession from one IP with 429 + Retry-After', async () => {
    const registry = buildEchoRegistry()
    const ip = '203.0.113.10'

    // 30 should pass.
    for (let i = 0; i < 30; i++) {
      const res = await dispatch(registry, 'com.atproto.server.createSession', postFromIp(ip))
      expect(res.status).toBe(200)
    }

    // The 31st flips.
    const blocked = await dispatch(
      registry,
      'com.atproto.server.createSession',
      postFromIp(ip),
    )
    expect(blocked.status).toBe(429)
    const retryAfter = blocked.headers.get('retry-after')
    expect(retryAfter).not.toBeNull()
    expect(Number(retryAfter)).toBeGreaterThan(0)
    const body = await blocked.json()
    expect(body.error).toBe('RateLimitExceeded')
  })

  it('isolates IPs — a second IP in parallel is unaffected', async () => {
    const registry = buildEchoRegistry()
    const ipA = '203.0.113.20'
    const ipB = '198.51.100.5'

    // Burn ipA's budget.
    for (let i = 0; i < 30; i++) {
      await dispatch(registry, 'com.atproto.server.createSession', postFromIp(ipA))
    }
    const aBlocked = await dispatch(
      registry,
      'com.atproto.server.createSession',
      postFromIp(ipA),
    )
    expect(aBlocked.status).toBe(429)

    // ipB's bucket is untouched.
    for (let i = 0; i < 30; i++) {
      const r = await dispatch(
        registry,
        'com.atproto.server.createSession',
        postFromIp(ipB),
      )
      expect(r.status).toBe(200)
    }
  })

  it('increments pds_rate_limit_rejected_total on rejection', async () => {
    const registry = buildEchoRegistry()
    const ip = '203.0.113.30'
    for (let i = 0; i < 30; i++) {
      await dispatch(registry, 'com.atproto.server.createSession', postFromIp(ip))
    }
    await dispatch(registry, 'com.atproto.server.createSession', postFromIp(ip))
    await dispatch(registry, 'com.atproto.server.createSession', postFromIp(ip))

    const text = await handleMetrics().text()
    const match = text.match(
      /pds_rate_limit_rejected_total\{nsid="com\.atproto\.server\.createSession"\}\s+(\d+)/,
    )
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(2)
  })

  it('passes through unlimited NSIDs untouched', async () => {
    const registry = new HandlerRegistry()
    registry.register('test.echo', {
      method: 'GET',
      handler: async () => ({ ok: true }),
    })
    const url = new URL('http://localhost/xrpc/test.echo')
    // 200 calls; nothing in the policy table for `test.echo` so the
    // limiter never gates.
    for (let i = 0; i < 50; i++) {
      const res = await dispatch(
        registry,
        'test.echo',
        new Request(url, { headers: { 'x-forwarded-for': '203.0.113.40' } }),
      )
      expect(res.status).toBe(200)
    }
  })
})
