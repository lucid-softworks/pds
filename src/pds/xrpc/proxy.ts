// PDS-as-proxy for atproto AppView / chat / labeler services.
//
// The PDS owns the user's repo (`com.atproto.*`); their AppView owns the
// world view (`app.bsky.*`), chat service owns DMs (`chat.bsky.*`), and so
// on. The atproto convention is that *every* request from the client
// arrives at the user's PDS, and the PDS forwards anything outside its
// own NSID space to the right service, signing the forwarded request
// with a one-shot service-auth JWT issued from the user's repo key.
//
// Wire shape:
//   1. Client sends `Atproto-Proxy: <did>#<service-id>` along with the
//      normal `Authorization: Bearer <pds-access-jwt>`.
//   2. PDS verifies the user's session via the access JWT (so we know
//      who's making the call).
//   3. PDS resolves the target DID to a `serviceEndpoint` URL by reading
//      the DID document and finding the service with id `#<service-id>`.
//   4. PDS mints a fresh ES256K JWT signed by the user's repo signing
//      key, with `iss = user.did`, `aud = target.did`, `lxm = nsid`,
//      and a 60-second TTL.
//   5. PDS reissues the request against the target with the new bearer,
//      streaming the body forward, then streams the upstream response
//      back to the client.
//
// Bsky.app and the official mobile apps only ever talk to their user's
// PDS. Without this module, every `app.bsky.*` call 404s with
// `MethodNotImplemented` — which is what motivated us to write this.
//
// See chapter 17 — PDS vs AppView vs Relay.

import { eq } from 'drizzle-orm'

import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { resolveDid } from '~/pds/did/resolver'
import { getKeyWrapper } from '~/pds/auth/key_wrap'
import { mintServiceAuthWithKey } from '~/pds/auth/service_auth'
import { applyReadAfterWrite } from '~/pds/read_after_write'
import { getAuthorFeedMunge, type AuthorFeedResponse } from '~/pds/read_after_write/munges/getAuthorFeed'
import { BadRequest, NotFound, InternalError, Unauthorized } from './errors'

/** NSIDs whose proxied response benefits from read-after-write — the
 *  AppView's snapshot might be stale relative to the user's own writes,
 *  and we merge in the missing records before returning. */
const READ_AFTER_WRITE_MUNGES: Record<
  string,
  (
    res: Response,
    requester: string,
  ) => Promise<Response>
> = {
  'app.bsky.feed.getAuthorFeed': (res, requester) =>
    applyReadAfterWrite<AuthorFeedResponse>(res, {
      requester,
      munge: getAuthorFeedMunge,
    }),
}

/** Headers we strip when forwarding upstream. `host`, `connection`,
 *  `content-length`, etc. would be wrong for the new request; the auth
 *  header is replaced with the freshly-minted service-auth JWT;
 *  `atproto-proxy` shouldn't recurse. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'authorization',
  'atproto-proxy',
])

/** Headers we strip from the upstream response before returning to the
 *  client. Caddy / Node will set these on the way out; if we forward the
 *  upstream's versions, things break (double content-length, broken
 *  chunking, etc.). */
const UPSTREAM_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding', // upstream may have gzipped; we re-encode on the way out
])

/** Parse `Atproto-Proxy: did:web:api.bsky.app#bsky_appview`. The fragment
 *  is required — it identifies *which* service on the target DID we want
 *  (a DID can advertise multiple services, e.g. atproto_pds + bsky_appview).
 *  Returns null when malformed; callers should reject with 400. */
export function parseProxyHeader(
  value: string,
): { did: string; serviceId: string } | null {
  const idx = value.indexOf('#')
  if (idx < 1 || idx === value.length - 1) return null
  const did = value.slice(0, idx)
  const serviceId = value.slice(idx + 1)
  if (!did.startsWith('did:')) return null
  return { did, serviceId }
}

/** Look up `did` in the resolver, find the service with id `#<serviceId>`,
 *  return its `serviceEndpoint`. Returns null if either step fails. */
export async function resolveProxyEndpoint(
  did: string,
  serviceId: string,
): Promise<string | null> {
  const doc = await resolveDid(did)
  if (!doc) return null
  const fragment = '#' + serviceId
  for (const svc of doc.service ?? []) {
    // Service IDs come back as either `#<id>` (relative) or
    // `<did>#<id>` (absolute). Accept both.
    if (svc.id === fragment || svc.id === did + fragment) {
      const url = svc.serviceEndpoint
      if (typeof url === 'string' && /^https?:\/\//.test(url)) return url
      return null
    }
  }
  return null
}


/** Forward the in-flight request to `upstreamUrl` with the service-auth
 *  bearer, preserving body + safe headers, and return the upstream's
 *  response as our response. */
export async function proxyForward(args: {
  upstreamUrl: string
  request: Request
  serviceAuth: string
}): Promise<Response> {
  const forwardHeaders = new Headers()
  args.request.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) forwardHeaders.set(k, v)
  })
  forwardHeaders.set('authorization', `Bearer ${args.serviceAuth}`)
  // Upstreams should never see our public origin in the Host header.
  // Fetch will set it from the URL.

  // GET / HEAD have no body; otherwise stream what we got. The web Fetch
  // spec requires `duplex: 'half'` for streamed bodies in Node 18+.
  const method = args.request.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: forwardHeaders,
    redirect: 'manual',
  }
  if (hasBody) {
    init.body = args.request.body
    init.duplex = 'half'
  }

  const upstreamRes = await fetch(args.upstreamUrl, init)

  const downstreamHeaders = new Headers()
  upstreamRes.headers.forEach((v, k) => {
    if (!UPSTREAM_HOP_BY_HOP.has(k.toLowerCase())) downstreamHeaders.set(k, v)
  })
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: downstreamHeaders,
  })
}

/** Orchestrator. The XRPC dispatcher calls this when the request carries
 *  an `Atproto-Proxy` header AND the NSID isn't local. Returns the proxy
 *  response, or throws an XrpcError the dispatcher turns into JSON. */
export async function dispatchViaProxy(args: {
  nsid: string
  request: Request
  /** DID of the already-verified caller — the dispatcher runs
   *  `requireAccessAuth` (or the OAuth equivalent) before us so we don't
   *  have to. The DID is the only thing we need to look up the signing
   *  key. */
  callerDid: string
}): Promise<Response> {
  const headerValue = args.request.headers.get('atproto-proxy')
  if (!headerValue) {
    // Shouldn't happen if the dispatcher routed us here — defensive.
    throw BadRequest('atproto-proxy header missing', 'InvalidRequest')
  }
  const target = parseProxyHeader(headerValue.trim())
  if (!target) {
    throw BadRequest(
      'atproto-proxy must look like did:...#<service-id>',
      'InvalidRequest',
    )
  }

  const upstreamBase = await resolveProxyEndpoint(target.did, target.serviceId)
  if (!upstreamBase) {
    throw NotFound(
      `cannot resolve atproto-proxy target ${target.did}#${target.serviceId}`,
      'XrpcProxyTargetNotFound',
    )
  }

  // Look up the requester's signing key. We unwrap on every call rather
  // than caching — the wrapper can be backed by a KMS that prefers
  // fresh authorizations, and the per-call cost is negligible compared
  // to the network hop to the AppView.
  const rows = await db
    .select({
      did: accounts.did,
      signingKeyPriv: accounts.signingKeyPriv,
    })
    .from(accounts)
    .where(eq(accounts.did, args.callerDid))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw Unauthorized(
      `account ${args.callerDid} not found locally`,
      'AccountNotFound',
    )
  }
  let signingKeyPriv: string
  try {
    signingKeyPriv = await getKeyWrapper().unwrap(row.signingKeyPriv)
  } catch (err) {
    throw InternalError(`failed to unwrap signing key: ${(err as Error).message}`)
  }

  const { jwt: serviceAuth } = await mintServiceAuthWithKey({
    did: args.callerDid,
    signingKeyPriv,
    audience: target.did,
    lxm: args.nsid,
  })

  const url = new URL(args.request.url)
  const upstreamUrl =
    upstreamBase.replace(/\/$/, '') +
    '/xrpc/' +
    encodeURIComponent(args.nsid) +
    url.search

  const upstreamRes = await proxyForward({
    upstreamUrl,
    request: args.request,
    serviceAuth,
  })

  // Read-after-write hook: if this NSID has a registered munge, run the
  // AppView's response through it so the user's recent local writes
  // appear in the response.
  const munger = READ_AFTER_WRITE_MUNGES[args.nsid]
  if (munger && upstreamRes.status === 200) {
    try {
      return await munger(upstreamRes, args.callerDid)
    } catch {
      // Munge failed — best-effort: return upstream as-is. The original
      // response body was already consumed by `applyReadAfterWrite`'s
      // text() call, but on error it returns the unparsed text in a
      // fresh Response, so the client still gets a valid body.
      return upstreamRes
    }
  }
  return upstreamRes
}
