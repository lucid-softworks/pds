// Per-NSID, per-IP rate limiting for the XRPC dispatcher.
//
// Two pieces ship: a pluggable `RateLimitStore` interface with an
// in-memory token-bucket implementation (the default), and a hardcoded
// policy table mapping NSIDs to `{ capacity, windowMs }` limits. The
// dispatcher calls `rateLimitFor(nsid, method)` once per request; a
// non-null result is then checked against the store. A `null` return
// short-circuits — most endpoints (the read paths, the firehose, the
// well-knowns) aren't rate-limited at all.
//
// The store is a token bucket, not a sliding window. Token buckets are
// cheap (one map lookup + one timestamp diff) and forgiving of bursty
// traffic (refill is continuous). The downside — a determined attacker
// can spread requests evenly across the window and consume nearly 2x the
// nominal rate at the boundary — is fine for an outer-edge cap; the
// per-account flow controls (password retry lockouts, etc.) sit
// downstream and catch what slips through.
//
// IP derivation. We trust `X-Forwarded-For` from a reverse proxy because
// in any realistic deployment Caddy / nginx / a cloud LB strips
// client-spoofed headers and re-sets the trusted chain. The teaching
// port doesn't ship its own proxy validation — operators wire that at
// the proxy. Missing XFF (no proxy, or a misconfigured one) collapses
// every caller into a single 'unknown' bucket, which is fine in dev (one
// developer hits localhost) and a configuration smell in prod — we log
// a one-shot warn the first time we see it.
//
// See chapter 18 — Rate limiting.

import { getLogger } from '~/lib/logger'

const log = getLogger('rate-limit')

export type RateLimitKey = string // typically `${ip}:${nsid}`

export type RateLimit = {
  /** Allowed requests per window. */
  capacity: number
  /** Window in milliseconds. */
  windowMs: number
}

export type RateLimitResult =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; retryAfterMs: number }

export interface RateLimitStore {
  /** Atomically check + decrement the bucket. */
  check(key: RateLimitKey, limit: RateLimit): Promise<RateLimitResult>
}

// ---------------------------------------------------------------------------
// In-memory token bucket
// ---------------------------------------------------------------------------

type Bucket = {
  /** Remaining requests at `lastRefillMs`. */
  tokens: number
  /** Last refill timestamp (ms epoch). */
  lastRefillMs: number
}

/** Single-process token bucket store. Fine for a single PDS process; if
 *  you run two replicas, they each see ~half the per-IP traffic and the
 *  effective cap doubles. Swap in `RedisRateLimitStore` if that matters
 *  to you. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<RateLimitKey, Bucket>()
  /** Injectable clock for tests. Default: Date.now. */
  private now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  async check(key: RateLimitKey, limit: RateLimit): Promise<RateLimitResult> {
    const now = this.now()
    const refillRatePerMs = limit.capacity / limit.windowMs
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { tokens: limit.capacity, lastRefillMs: now }
      this.buckets.set(key, bucket)
    } else {
      const elapsed = now - bucket.lastRefillMs
      if (elapsed > 0) {
        bucket.tokens = Math.min(
          limit.capacity,
          bucket.tokens + elapsed * refillRatePerMs,
        )
        bucket.lastRefillMs = now
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      const remaining = Math.floor(bucket.tokens)
      // resetAt: when the bucket would refill to full capacity.
      const tokensToFull = limit.capacity - bucket.tokens
      const resetAt = now + Math.ceil(tokensToFull / refillRatePerMs)
      return { allowed: true, remaining, resetAt }
    }

    // Not enough tokens; how long until we'd have one?
    const deficit = 1 - bucket.tokens
    const retryAfterMs = Math.max(1, Math.ceil(deficit / refillRatePerMs))
    return { allowed: false, retryAfterMs }
  }

  /** Test-only escape hatch. */
  _clear(): void {
    this.buckets.clear()
  }
}

// ---------------------------------------------------------------------------
// Redis-backed stub
// ---------------------------------------------------------------------------

/** A Redis-backed store would atomically run something like
 *
 *     local current = redis.call('GET', KEYS[1])
 *     if not current then
 *       redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1] - 1)
 *       return ARGV[1] - 1
 *     end
 *     if tonumber(current) <= 0 then
 *       return -redis.call('PTTL', KEYS[1])
 *     end
 *     redis.call('DECR', KEYS[1])
 *     return current - 1
 *
 *  inside a Lua script (so check + decrement are atomic across replicas).
 *  We don't ship one — the teaching port has a "no new deps" rule and
 *  `ioredis` is the obvious add. Operators who need cross-process limits
 *  wire this up and inject via `getRateLimitStore`. */
export class RedisRateLimitStore implements RateLimitStore {
  async check(_key: RateLimitKey, _limit: RateLimit): Promise<RateLimitResult> {
    throw new Error(
      'RedisRateLimitStore is not implemented in the teaching port. ' +
        'See chapter 18 — Rate limiting for the SETEX+DECR Lua sketch.',
    )
  }
}

let cachedStore: RateLimitStore | null = null

export function getRateLimitStore(): RateLimitStore {
  if (cachedStore) return cachedStore
  cachedStore = new InMemoryRateLimitStore()
  return cachedStore
}

/** Test-only: swap the process-wide store. */
export function _setRateLimitStoreForTests(s: RateLimitStore | null): void {
  cachedStore = s
}

// ---------------------------------------------------------------------------
// Policy table
// ---------------------------------------------------------------------------

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Hardcoded NSID → limit table. Mirrors the upstream PDS roughly, with
 *  a few rounding conveniences. Returns null for NSIDs that aren't rate
 *  limited — most reads + the firehose subscription. */
const POLICY: Record<string, RateLimit | null> = {
  // ---- account creation / session lifecycle ----
  'com.atproto.server.createAccount': { capacity: 100, windowMs: 1 * DAY },
  'com.atproto.server.createSession': { capacity: 30, windowMs: 5 * MIN },
  'com.atproto.server.refreshSession': { capacity: 50, windowMs: 5 * MIN },

  // ---- email-token flows ----
  'com.atproto.server.requestPasswordReset': { capacity: 5, windowMs: 5 * MIN },
  'com.atproto.server.resetPassword': { capacity: 5, windowMs: 5 * MIN },
  'com.atproto.server.requestEmailConfirmation': {
    capacity: 5,
    windowMs: 5 * MIN,
  },
  'com.atproto.server.requestEmailUpdate': {
    capacity: 5,
    windowMs: 5 * MIN,
  },
  'com.atproto.server.requestAccountDelete': {
    capacity: 5,
    windowMs: 5 * MIN,
  },

  // ---- identity ----
  'com.atproto.identity.updateHandle': { capacity: 10, windowMs: 5 * MIN },
  'com.atproto.identity.requestPlcOperationSignature': {
    capacity: 5,
    windowMs: 5 * MIN,
  },

  // ---- repo writes ----
  'com.atproto.repo.uploadBlob': { capacity: 5000, windowMs: 1 * HOUR },
  'com.atproto.repo.createRecord': { capacity: 7000, windowMs: 1 * HOUR },
  'com.atproto.repo.putRecord': { capacity: 7000, windowMs: 1 * HOUR },
  'com.atproto.repo.deleteRecord': { capacity: 7000, windowMs: 1 * HOUR },
  'com.atproto.repo.applyWrites': { capacity: 7000, windowMs: 1 * HOUR },
}

/** Look up the rate limit for a given NSID. Returns null when the NSID
 *  isn't policy'd (no limit). Method is accepted for symmetry — today
 *  we don't vary by method, but a future revision might want
 *  separate buckets for GET vs POST against the same NSID. */
export function rateLimitFor(nsid: string, _method: string): RateLimit | null {
  // `noUncheckedIndexedAccess` makes the index return undefined for
  // unknown keys; normalise to null.
  return POLICY[nsid] ?? null
}

// ---------------------------------------------------------------------------
// Caller IP derivation
// ---------------------------------------------------------------------------

let warnedAboutMissingXffOnce = false

/** Reset the one-shot "missing XFF" warning. Tests call this to keep
 *  cases independent. */
export function _resetMissingXffWarning(): void {
  warnedAboutMissingXffOnce = false
}

/** Extract the caller IP from request headers. Order of preference:
 *
 *    1. The first non-private hop in `X-Forwarded-For`.
 *    2. `X-Real-IP` (set by some reverse proxies in single-hop mode).
 *    3. The literal string 'unknown'.
 *
 *  We don't validate that XFF came from a trusted hop — the operator
 *  wires that at their reverse proxy. The 'unknown' fallback collapses
 *  every caller into a single bucket; in dev (`PDS_PUBLIC_URL`
 *  localhost) we accept that silently, in prod we emit a one-shot warn
 *  the first time it happens so a misconfigured proxy shows up in logs.
 */
export function callerIpFromRequest(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const candidate = pickPublicFromXff(xff)
    if (candidate) return candidate
  }
  const xri = request.headers.get('x-real-ip')
  if (xri && xri.trim()) return xri.trim()

  if (!warnedAboutMissingXffOnce && isProdLike()) {
    warnedAboutMissingXffOnce = true
    log.warn('missing-xforwarded-for', {
      hint: 'No X-Forwarded-For or X-Real-IP header. Every caller is in the same rate-limit bucket. Check your reverse proxy.',
    })
  }
  return 'unknown'
}

function isProdLike(): boolean {
  const url = process.env.PDS_PUBLIC_URL ?? ''
  // Match localhost, 127.0.0.1, and the loopback range we use in dev.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
    return false
  }
  return true
}

function pickPublicFromXff(xff: string): string | null {
  // XFF is a comma-separated list `client, proxy1, proxy2`. The leftmost
  // entry is the caller's claimed IP; subsequent entries are hops added
  // by intermediate proxies. We trust the leftmost public address.
  const parts = xff.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
  for (const part of parts) {
    if (!isPrivateIp(part)) return part
  }
  // Every hop was private — return the leftmost so dev setups (one proxy
  // on a private subnet) still get *some* per-caller bucketing.
  return parts[0] ?? null
}

function isPrivateIp(ip: string): boolean {
  // Strip an optional port from IPv4 ("1.2.3.4:5678" → "1.2.3.4"). For
  // bracketed IPv6 ("[::1]:5678") strip the brackets + port.
  let bare = ip
  if (bare.startsWith('[')) {
    const close = bare.indexOf(']')
    if (close >= 0) bare = bare.slice(1, close)
  } else if ((bare.match(/:/g) ?? []).length === 1) {
    bare = bare.split(':')[0] ?? bare
  }

  // IPv4 private ranges + loopback + link-local.
  if (/^10\./.test(bare)) return true
  if (/^192\.168\./.test(bare)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true
  if (/^127\./.test(bare)) return true
  if (/^169\.254\./.test(bare)) return true

  // IPv6 loopback + ULA + link-local.
  if (bare === '::1') return true
  if (/^fc[0-9a-f]{2}:/i.test(bare)) return true
  if (/^fd[0-9a-f]{2}:/i.test(bare)) return true
  if (/^fe80:/i.test(bare)) return true

  return false
}
