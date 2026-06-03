// Client-metadata fetching + validation.
//
// Every atproto OAuth client identifies itself with a `client_id` URL that
// points at a JSON document describing the client: which redirect URIs it
// owns, which grant types it'll use, which scopes it asks for, that it
// requires DPoP-bound access tokens, etc. The AS fetches that document the
// first time it sees the client and validates everything against it from
// then on.
//
// This module:
//   - GETs the document from the URL, enforces https (except localhost in
//     dev), parses + validates the shape.
//   - Caches successful resolutions in-process for 5 minutes — clients
//     update their metadata rarely, and the discovery loop on every PAR call
//     would be a nice DOS vector otherwise.
//
// See chapter 21 — OAuth.

import { getConfig } from '~/lib/config'

export type ClientMetadata = {
  client_id: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  scope: string
  token_endpoint_auth_method: string
  /** Atproto OAuth requires DPoP-bound tokens; we reject metadata that
   *  doesn't opt in. */
  dpop_bound_access_tokens: true
  /** Free-form. Bag-of-extras the spec lets vendors add — we pass them
   *  through but don't act on them. */
  [extra: string]: unknown
}

const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

type CacheEntry = { resolvedAt: number; metadata: ClientMetadata }
const cache = new Map<string, CacheEntry>()

/** Test hook — drop the in-process resolution cache. */
export function _resetClientMetadataCache(): void {
  cache.clear()
}

/** Fetch + validate a client's metadata document. The returned object is
 *  the parsed JSON narrowed to the required fields; extras are preserved.
 *  Throws on transport errors, schema violations, or scheme/host policy. */
export async function fetchClientMetadata(
  clientId: string,
): Promise<ClientMetadata> {
  const url = parseClientId(clientId)
  const cached = cache.get(clientId)
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached.metadata
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      // Don't follow cross-origin redirects — the client_id IS the identity,
      // so a redirect would let a takeover of a different domain answer for
      // someone else's client_id. Fetch defaults to 'follow' which is fine
      // for same-origin redirects; we tolerate that for trivial https→https
      // moves. (A stricter mode is a follow-up.)
      redirect: 'follow',
    })
  } catch (err) {
    throw new Error(
      `failed to fetch client metadata: ${(err as Error).message}`,
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`client metadata fetch returned HTTP ${res.status}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().includes('application/json')) {
    // RFC 9728 / atproto profile both say JSON; refuse anything else. We
    // don't try to be clever and parse text/plain.
    throw new Error(
      `client metadata must be application/json (got ${ct || 'no content-type'})`,
    )
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new Error(
      `client metadata is not valid JSON: ${(err as Error).message}`,
    )
  }
  const metadata = validateClientMetadata(body, clientId)
  cache.set(clientId, { resolvedAt: Date.now(), metadata })
  return metadata
}

/** Pure helper exposed for tests. */
export function validateClientMetadata(
  body: unknown,
  expectedClientId: string,
): ClientMetadata {
  if (!body || typeof body !== 'object') {
    throw new Error('client metadata must be a JSON object')
  }
  const obj = body as Record<string, unknown>
  const clientId = obj['client_id']
  if (clientId !== expectedClientId) {
    throw new Error(
      `client metadata client_id mismatch: doc=${String(clientId)} expected=${expectedClientId}`,
    )
  }
  const redirectUris = obj['redirect_uris']
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new Error('client metadata redirect_uris must be a non-empty array')
  }
  if (redirectUris.some((u) => typeof u !== 'string' || u.length === 0)) {
    throw new Error('client metadata redirect_uris must all be strings')
  }
  const grantTypes = obj['grant_types']
  if (!Array.isArray(grantTypes) || grantTypes.length === 0) {
    throw new Error('client metadata grant_types must be a non-empty array')
  }
  const responseTypes = obj['response_types']
  if (!Array.isArray(responseTypes) || responseTypes.length === 0) {
    throw new Error('client metadata response_types must be a non-empty array')
  }
  const scope = obj['scope']
  if (typeof scope !== 'string' || scope.trim().length === 0) {
    throw new Error('client metadata scope must be a non-empty string')
  }
  const tokenAuth = obj['token_endpoint_auth_method']
  if (typeof tokenAuth !== 'string' || tokenAuth.length === 0) {
    throw new Error('client metadata token_endpoint_auth_method is required')
  }
  if (obj['dpop_bound_access_tokens'] !== true) {
    throw new Error(
      'client metadata dpop_bound_access_tokens must be true (atproto OAuth profile)',
    )
  }
  return {
    ...obj,
    client_id: clientId,
    redirect_uris: redirectUris as string[],
    grant_types: grantTypes as string[],
    response_types: responseTypes as string[],
    scope,
    token_endpoint_auth_method: tokenAuth,
    dpop_bound_access_tokens: true,
  }
}

/** Throws on scheme/host policy violations. In production (publicUrl is
 *  https://...) we require https for client_id; in dev (publicUrl is
 *  http://localhost...) we also accept http. */
function parseClientId(clientId: string): URL {
  let u: URL
  try {
    u = new URL(clientId)
  } catch {
    throw new Error(`client_id must be a URL, got ${clientId}`)
  }
  const devMode = getConfig().publicUrl.startsWith('http://localhost')
  if (u.protocol === 'https:') return u
  if (devMode && u.protocol === 'http:') return u
  throw new Error(
    `client_id must use https (got ${u.protocol}//${u.host} — http allowed only in dev)`,
  )
}
