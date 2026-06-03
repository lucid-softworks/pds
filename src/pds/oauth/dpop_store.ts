// Replay-protection store for DPoP `jti` values.
//
// `verifyDpopProof` (see `./dpop.ts`) refuses to honour the same `jti` twice
// inside the spec's ±60s `iat` window. That's "don't accept a proof we
// already accepted" — which only works if the verifier remembers proofs it
// has seen.
//
// In a single-process deployment a Map in RAM is the obvious thing. In a
// multi-replica deployment that Map is no longer shared: an attacker who
// captures a valid proof in transit can replay it against a different
// replica until the proof's `iat` tolerance elapses. The defence is a
// shared store — Redis is the typical choice — running SETNX with a 60s
// expiry so the "set if absent" check + the "expire entries" sweep are
// both atomic across replicas.
//
// This file plumbs that future swap behind an interface, mirroring the
// shape the rate-limit store uses (`src/pds/xrpc/rate_limit.ts`):
//
//   - `DpopReplayStore`            — the interface
//   - `InMemoryDpopReplayStore`    — the default, single-process Map
//   - `RedisDpopReplayStore`       — a stub that documents the pattern and
//                                    throws on construct
//   - `getDpopReplayStore()`       — picks one once, based on env
//
// See chapter 21 — OAuth, "What's still missing" / "Plumbing".

/** A `jti` we've recently accepted gets remembered for this long. DPoP
 *  proofs themselves are valid for ±60s around their `iat`, so a window
 *  any longer is wasted memory and any shorter opens a replay gap. */
const REPLAY_WINDOW_MS = 60_000

/** Hard cap on the in-memory cache. At one entry per accepted proof and a
 *  60-second window, 16384 is comfortably above any single-process burst
 *  rate we'd plausibly hit — the rate-limit store would have triggered
 *  long before. The cap exists so a pathological burst can't OOM the
 *  process. */
const REPLAY_CACHE_LIMIT = 16384

export interface DpopReplayStore {
  /** Atomically check if `jti` has been seen within the current window AND
   *  record it if not. Returns:
   *  - { firstSeen: true }   — proof is fresh, request continues
   *  - { firstSeen: false }  — replay; reject the request
   *  The window is fixed at ~60s — DPoP proofs themselves expire that fast,
   *  so we don't need a per-call argument. */
  checkAndRecord(jti: string): Promise<{ firstSeen: boolean }>

  /** Visible-for-testing: drop all state. */
  reset?(): Promise<void>
}

// ---------------------------------------------------------------------------
// In-memory map-with-expiry
// ---------------------------------------------------------------------------

/** Single-process replay store. A Map keyed by `jti` to its expiry time in
 *  ms epoch. On every check we sweep expired entries first (lazy cleanup),
 *  then check + set. If the cap would be exceeded after that sweep, we
 *  drop the oldest entry by insertion order — JavaScript Maps iterate in
 *  insertion order, so `keys().next().value` is the right victim. */
export class InMemoryDpopReplayStore implements DpopReplayStore {
  private readonly seen = new Map<string, number>()
  /** Injectable clock for tests. Default: Date.now. */
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  async checkAndRecord(jti: string): Promise<{ firstSeen: boolean }> {
    const now = this.now()

    // Step 1 — lazy expiry sweep. Walk the whole map once; cheap at our
    // working-set size (cap = 16384) and keeps replay-detection O(1) on
    // the steady path.
    for (const [k, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(k)
    }

    // Step 2 — replay check. Anything still in the map after the sweep
    // is by definition unexpired.
    if (this.seen.has(jti)) {
      return { firstSeen: false }
    }

    // Step 3 — cap enforcement. If recording one more would push us
    // past the limit, evict the oldest by insertion order. JS `Map`
    // preserves insertion order, so `keys().next().value` is the
    // oldest live entry.
    if (this.seen.size >= REPLAY_CACHE_LIMIT) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }

    this.seen.set(jti, now + REPLAY_WINDOW_MS)
    return { firstSeen: true }
  }

  async reset(): Promise<void> {
    this.seen.clear()
  }
}

// ---------------------------------------------------------------------------
// Redis-backed stub
// ---------------------------------------------------------------------------

/** Production-shaped stub. A real implementation would atomically run
 *
 *      if redis.call('SET', KEYS[1], 1, 'NX', 'EX', 60) then
 *        return 1  -- firstSeen
 *      else
 *        return 0  -- replay
 *      end
 *
 *  inside a Lua script (so check + set + expire are atomic across
 *  replicas). We don't ship one — the teaching port has a "no new deps"
 *  rule and `ioredis` is the obvious add. Operators who need cross-
 *  process replay protection wire this up and inject via
 *  `getDpopReplayStore`. */
export class RedisDpopReplayStore implements DpopReplayStore {
  async checkAndRecord(_jti: string): Promise<{ firstSeen: boolean }> {
    // Production Redis Lua sketch:
    //   if redis.call('SET', KEYS[1], 1, 'NX', 'EX', 60) then
    //     return 1  -- firstSeen
    //   else
    //     return 0  -- replay
    //   end
    throw new Error(
      'RedisDpopReplayStore not implemented in teaching port — ' +
        'see chapter 21 for the SETNX EX 60 pattern.',
    )
  }
}

// ---------------------------------------------------------------------------
// Process-wide selector
// ---------------------------------------------------------------------------

let cachedStore: DpopReplayStore | null = null

/** Picked once at first use based on `PDS_DPOP_REPLAY_STORE`. Default
 *  `'in-memory'`. `'redis'` returns the stub, which throws on first
 *  `checkAndRecord`. */
export function getDpopReplayStore(): DpopReplayStore {
  if (cachedStore) return cachedStore
  // We read env directly here (rather than going through `getConfig`) for
  // the same reason `getRateLimitStore` does: the store is constructed
  // lazily on the first request, by which point the config layer has
  // already failed loudly on any missing required vars. The selector is
  // additive — both branches succeed at construct time; the redis branch
  // only throws on first call.
  const kind = (process.env['PDS_DPOP_REPLAY_STORE'] ?? 'in-memory').toLowerCase()
  cachedStore = kind === 'redis' ? new RedisDpopReplayStore() : new InMemoryDpopReplayStore()
  return cachedStore
}

/** Test-only: swap the process-wide store. Pass `null` to force the next
 *  `getDpopReplayStore()` call to re-read env and reconstruct. */
export function _setDpopReplayStoreForTests(s: DpopReplayStore | null): void {
  cachedStore = s
}
