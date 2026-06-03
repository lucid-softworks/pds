// Unified DID resolver — local accounts, did:plc via plc.directory, did:web
// via well-known. Wraps `resolveLocalDid` so callers don't need to know
// whether a DID is one of ours.
//
// Negative caching exists so a flood of requests for an unknown DID doesn't
// hammer plc.directory. The TTLs are conservative; flip them down or call
// `resetResolverCache()` from tests.

import { resolveLocalDid } from './resolver'
import { fetchPlcDoc, fetchWebDoc } from './plc_client'
import type { DidDocument } from './document'

const POSITIVE_TTL_MS = 5 * 60 * 1000
const NEGATIVE_TTL_MS = 30 * 1000

type CacheEntry = { doc: DidDocument | null; expiresAt: number }
const cache = new Map<string, CacheEntry>()

export async function resolveDid(did: string): Promise<DidDocument | null> {
  const now = Date.now()
  const hit = cache.get(did)
  if (hit && hit.expiresAt > now) return hit.doc

  const doc = await resolveUncached(did)
  cache.set(did, {
    doc,
    expiresAt: now + (doc ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  })
  return doc
}

async function resolveUncached(did: string): Promise<DidDocument | null> {
  // Local first — own DIDs short-circuit before any network call.
  const local = await resolveLocalDid(did)
  if (local) return local

  if (did.startsWith('did:plc:')) {
    return fetchPlcDoc(did)
  }
  if (did.startsWith('did:web:')) {
    return fetchWebDoc(did)
  }
  return null
}

export function resetResolverCache(): void {
  cache.clear()
}
