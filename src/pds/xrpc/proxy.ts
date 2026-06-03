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
import { SignJWT, importJWK, type KeyLike } from 'jose'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { resolveDid } from '~/pds/did/resolver'
import { getKeyWrapper } from '~/pds/auth/key_wrap'
import { BadRequest, NotFound, InternalError, Unauthorized } from './errors'

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

const SERVICE_AUTH_TTL_SECONDS = 60

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

/** Mint a one-shot service-auth JWT, signed ES256K with the user's repo
 *  signing key. The receiver verifies against the public key in the
 *  user's DID document (the same key that signs commits), so this is the
 *  canonical cross-service authentication primitive in atproto. */
export async function mintProxyServiceAuth(args: {
  requesterDid: string
  signingKeyPriv: string // hex k256 scalar (plaintext, already unwrapped)
  audience: string
  lxm: string
}): Promise<string> {
  const key = await importSigningKey(args.signingKeyPriv)
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + SERVICE_AUTH_TTL_SECONDS
  const jti = randomBytes(16).toString('base64url')
  return await new SignJWT({ lxm: args.lxm })
    .setProtectedHeader({ alg: 'ES256K', typ: 'JWT' })
    .setIssuer(args.requesterDid)
    .setAudience(args.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key)
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

  const serviceAuth = await mintProxyServiceAuth({
    requesterDid: args.callerDid,
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

  return await proxyForward({
    upstreamUrl,
    request: args.request,
    serviceAuth,
  })
}

/** Convert a 32-byte hex k256 scalar into a jose-usable `KeyLike` for
 *  ES256K signing. Mirrors the pattern in src/pds/oauth/tokens.ts. */
async function importSigningKey(privateKeyHex: string): Promise<KeyLike> {
  const privBytes = decodeHex(privateKeyHex)
  const pub = secp256k1.getPublicKey(privBytes, false)
  const x = pub.slice(1, 33)
  const y = pub.slice(33, 65)
  const jwk = {
    kty: 'EC',
    crv: 'secp256k1',
    x: Buffer.from(x).toString('base64url'),
    y: Buffer.from(y).toString('base64url'),
    d: Buffer.from(privBytes).toString('base64url'),
    alg: 'ES256K',
    use: 'sig',
  }
  return (await importJWK(jwk, 'ES256K')) as KeyLike
}

function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
