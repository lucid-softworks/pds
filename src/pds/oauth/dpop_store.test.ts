// Behaviour contract for the DPoP replay store.
//
// Two halves: the in-memory map-with-expiry (first-seen vs replay,
// expiry sweep, cap-overflow eviction), and the Redis stub (throws
// with a chapter pointer so an operator immediately knows where to
// look).

import { describe, expect, it } from 'vitest'

import {
  InMemoryDpopReplayStore,
  RedisDpopReplayStore,
} from './dpop_store'

describe('InMemoryDpopReplayStore', () => {
  it('returns firstSeen=true on the first check', async () => {
    const store = new InMemoryDpopReplayStore({ now: () => 0 })
    const r = await store.checkAndRecord('jti-a')
    expect(r.firstSeen).toBe(true)
  })

  it('returns firstSeen=false on the second check with the same jti', async () => {
    const store = new InMemoryDpopReplayStore({ now: () => 0 })
    const first = await store.checkAndRecord('jti-a')
    const second = await store.checkAndRecord('jti-a')
    expect(first.firstSeen).toBe(true)
    expect(second.firstSeen).toBe(false)
  })

  it('isolates different jti values', async () => {
    const store = new InMemoryDpopReplayStore({ now: () => 0 })
    const a = await store.checkAndRecord('jti-a')
    const b = await store.checkAndRecord('jti-b')
    expect(a.firstSeen).toBe(true)
    expect(b.firstSeen).toBe(true)
    // Each is now individually held.
    expect((await store.checkAndRecord('jti-a')).firstSeen).toBe(false)
    expect((await store.checkAndRecord('jti-b')).firstSeen).toBe(false)
  })

  it('accepts the same jti again after the 60s window expires', async () => {
    const clock = { t: 0 }
    const store = new InMemoryDpopReplayStore({ now: () => clock.t })
    const first = await store.checkAndRecord('jti-a')
    expect(first.firstSeen).toBe(true)
    // Advance past the 60s window. The sweep on the next call drops
    // the entry and the proof is treated as fresh again — which is
    // exactly the behaviour `verifyDpopProof` already covers by also
    // refusing proofs whose `iat` is more than ±60s old.
    clock.t = 61_000
    const again = await store.checkAndRecord('jti-a')
    expect(again.firstSeen).toBe(true)
  })

  it('drops the oldest entry when the cap (16384) would be exceeded', async () => {
    // Use a steady clock so nothing is expired by the sweep — that
    // forces the cap-eviction branch to be the one that fires.
    const store = new InMemoryDpopReplayStore({ now: () => 0 })
    // Fill the cap with a deterministic sequence so we know which
    // entry is oldest by insertion order.
    for (let i = 0; i < 16384; i++) {
      const r = await store.checkAndRecord(`jti-${i}`)
      expect(r.firstSeen).toBe(true)
    }
    // One more insert pushes us over the cap; the oldest (`jti-0`)
    // should be evicted.
    const overflow = await store.checkAndRecord('jti-overflow')
    expect(overflow.firstSeen).toBe(true)
    // Check jti-1 *before* jti-0: jti-1 is still held (only the single
    // oldest entry was dropped). If we checked jti-0 first that
    // re-insertion would evict jti-1 in turn, masking the assertion.
    const reJti1 = await store.checkAndRecord('jti-1')
    expect(reJti1.firstSeen).toBe(false)
    // jti-0 was evicted, so re-presenting it now reads as fresh.
    const reJti0 = await store.checkAndRecord('jti-0')
    expect(reJti0.firstSeen).toBe(true)
  })

  it('reset() drops all state', async () => {
    const store = new InMemoryDpopReplayStore({ now: () => 0 })
    await store.checkAndRecord('jti-a')
    expect((await store.checkAndRecord('jti-a')).firstSeen).toBe(false)
    await store.reset()
    expect((await store.checkAndRecord('jti-a')).firstSeen).toBe(true)
  })
})

describe('RedisDpopReplayStore', () => {
  it('throws on checkAndRecord with a chapter-21 pointer', async () => {
    const store = new RedisDpopReplayStore()
    await expect(store.checkAndRecord('jti-a')).rejects.toThrow(/chapter 21/)
  })
})
