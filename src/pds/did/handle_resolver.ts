// Cross-PDS handle resolution.
//
// The AT Protocol spec gives a handle two equivalent resolution paths:
//
//   1. DNS: `_atproto.<handle>` TXT record contains `did=did:plc:...`.
//   2. HTTPS: GET `https://<handle>/.well-known/atproto-did` returns the
//      DID as a plain-text body.
//
// Either is normative on its own. We try both in parallel and accept the
// first answer. The result MUST be cross-checked against the resolved DID
// document's `alsoKnownAs` (it should list `at://<handle>`) before being
// trusted — that bidirectional check is what stops a domain from
// unilaterally claiming a DID.
//
// See chapter 04 — Data model: DIDs, handles, AT-URIs.

import { resolveTxt } from 'node:dns/promises'
import { isValidHandleSyntax } from './handle'
import { resolveDid } from './external_resolver'

// Conservative 5-minute positive cache + 30-second negative cache. The TTL
// is local to this process; production would use a shared store.
type CacheEntry = { did: string | null; expiresAt: number }
const cache = new Map<string, CacheEntry>()
const POSITIVE_TTL_MS = 5 * 60_000
const NEGATIVE_TTL_MS = 30_000

const TXT_TIMEOUT_MS = 3_000
const WELLKNOWN_TIMEOUT_MS = 3_000

const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%\-]+$/

/** Resolve a handle to a DID via DNS + well-known. Returns null on
 *  unresolvable. Does the bidirectional check against the DID doc's
 *  alsoKnownAs to confirm the DID actually claims this handle. */
export async function resolveHandleExternal(
  rawHandle: string,
): Promise<string | null> {
  const handle = rawHandle.trim().toLowerCase()
  if (!isValidHandleSyntax(handle)) return null

  const cached = cache.get(handle)
  if (cached && cached.expiresAt > Date.now()) return cached.did

  // Race the two methods — whichever answers first wins. We don't bail on
  // the first non-null because we need to validate the DID afterwards
  // anyway; treating them as equivalent is the spec's intent.
  const did = await firstNonNull([
    resolveHandleViaDns(handle),
    resolveHandleViaWellKnown(handle),
  ])

  if (!did) {
    cache.set(handle, { did: null, expiresAt: Date.now() + NEGATIVE_TTL_MS })
    return null
  }

  // Bidirectional check: the DID's document must list this handle in
  // alsoKnownAs. Without this step a malicious domain can point at any
  // DID it likes and a credulous client will accept it.
  const doc = await resolveDid(did)
  if (!doc) {
    cache.set(handle, { did: null, expiresAt: Date.now() + NEGATIVE_TTL_MS })
    return null
  }
  const claimsHandle = (doc.alsoKnownAs ?? []).some(
    (aka) => aka === `at://${handle}`,
  )
  if (!claimsHandle) {
    cache.set(handle, { did: null, expiresAt: Date.now() + NEGATIVE_TTL_MS })
    return null
  }

  cache.set(handle, { did, expiresAt: Date.now() + POSITIVE_TTL_MS })
  return did
}

/** Look up `_atproto.<handle>` TXT records, return the first `did=` answer.
 *  Returns null on NXDOMAIN, timeout, or no matching record. */
export async function resolveHandleViaDns(handle: string): Promise<string | null> {
  const queryHandle = `_atproto.${handle}`
  try {
    const records = await withTimeout(
      resolveTxt(queryHandle),
      TXT_TIMEOUT_MS,
    )
    for (const chunks of records) {
      const value = chunks.join('')
      const match = value.match(/^did=(did:[a-z]+:[^"\s]+)$/)
      if (match && DID_RE.test(match[1]!)) {
        return match[1]!
      }
    }
    return null
  } catch {
    return null
  }
}

/** GET https://<handle>/.well-known/atproto-did. Body is the DID. Returns
 *  null on any non-200, malformed body, or network failure. */
export async function resolveHandleViaWellKnown(
  handle: string,
): Promise<string | null> {
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, {
      signal: AbortSignal.timeout(WELLKNOWN_TIMEOUT_MS),
      headers: { accept: 'text/plain' },
    })
    if (!res.ok) return null
    const text = (await res.text()).trim()
    if (!DID_RE.test(text)) return null
    return text
  } catch {
    return null
  }
}

/** Reset the in-process cache. Test hook. */
export function resetHandleCache(): void {
  cache.clear()
}

async function firstNonNull<T>(promises: Promise<T | null>[]): Promise<T | null> {
  // Promise.any resolves on first fulfilled, but we want first NON-NULL.
  // Walk in arrival order via a small race loop.
  const settled = await Promise.allSettled(promises)
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value !== null) return r.value
  }
  return null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
