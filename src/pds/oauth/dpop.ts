// DPoP proof verification per RFC 9449.
//
// A DPoP proof is a small JWT the OAuth client signs with a key only it
// holds, and sends in the `DPoP:` header on every request. The proof binds
// the request method + URL to the client's private key — even if an attacker
// steals the access token, they can't forge a new proof, so the token is
// useless to them.
//
// We verify:
//   - JWT header has `typ: dpop+jwt` and an `alg` matching the embedded JWK.
//   - `htm` claim matches the HTTP method.
//   - `htu` claim matches the request URL (after stripping the query string
//     and fragment, per the spec).
//   - `iat` claim is within ±60s of now.
//   - `jti` claim hasn't been seen recently (small in-memory LRU cache).
//   - If we're verifying a request authenticated with an access token, the
//     proof's JWK thumbprint matches the token's `cnf.jkt`.
//
// We accept ES256 (P-256) and ES256K (secp256k1). The atproto OAuth profile
// requires ES256K; real-world clients commonly do ES256, and supporting both
// lets us interop with the wider OAuth ecosystem at zero extra cost.
//
// See chapter 21 — OAuth.

import { secp256k1 } from '@noble/curves/secp256k1'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  type JWK,
} from 'jose'

export type DpopVerifyArgs = {
  /** Raw `DPoP:` header value (the compact JWT). */
  dpopHeader: string
  /** HTTP method of the request, upper-case. */
  httpMethod: string
  /** Full request URL (we strip query/fragment before comparing). */
  httpUri: string
  /** If verifying a token-bound request, the access token's `cnf.jkt`. */
  expectedJkt?: string
  /** Override the clock — tests only. */
  now?: number
}

export type DpopVerifyResult = {
  /** RFC 7638 thumbprint of the client's DPoP key. */
  jkt: string
}

const IAT_TOLERANCE_SECONDS = 60
const REPLAY_WINDOW_MS = 60_000
const REPLAY_CACHE_LIMIT = 4096

/** Simple LRU-by-insertion-time cache of jti values we've recently accepted.
 *  Old entries are evicted lazily on insert. */
class JtiCache {
  private readonly seen = new Map<string, number>()

  has(jti: string, now: number): boolean {
    const ts = this.seen.get(jti)
    if (ts === undefined) return false
    if (now - ts > REPLAY_WINDOW_MS) {
      this.seen.delete(jti)
      return false
    }
    return true
  }

  remember(jti: string, now: number): void {
    // Evict expired + cap size.
    if (this.seen.size >= REPLAY_CACHE_LIMIT) {
      for (const [k, ts] of this.seen) {
        if (now - ts > REPLAY_WINDOW_MS) this.seen.delete(k)
        if (this.seen.size < REPLAY_CACHE_LIMIT) break
      }
      // If we're still at the cap, drop the oldest entry by insertion order.
      if (this.seen.size >= REPLAY_CACHE_LIMIT) {
        const oldestKey = this.seen.keys().next().value
        if (oldestKey !== undefined) this.seen.delete(oldestKey)
      }
    }
    this.seen.set(jti, now)
  }
}

const jtiCache = new JtiCache()

export function _resetDpopJtiCache(): void {
  // For tests — reset state between cases.
  ;(jtiCache as unknown as { seen: Map<string, number> }).seen.clear()
}

/** Validate a DPoP proof JWT. Throws on any failure with a message safe to
 *  surface as an OAuth error description. */
export async function verifyDpopProof(
  args: DpopVerifyArgs,
): Promise<DpopVerifyResult> {
  const { dpopHeader, httpMethod, httpUri, expectedJkt } = args
  if (!dpopHeader || dpopHeader.trim().length === 0) {
    throw new Error('DPoP header missing')
  }
  const proof = dpopHeader.trim()
  // Compact JWS: header.payload.signature
  const parts = proof.split('.')
  if (parts.length !== 3) {
    throw new Error('DPoP proof is not a compact JWT')
  }
  const [encodedHeader, encodedPayload, encodedSig] = parts as [
    string,
    string,
    string,
  ]
  let header: ReturnType<typeof decodeProtectedHeader>
  try {
    header = decodeProtectedHeader(proof)
  } catch {
    throw new Error('DPoP proof header is not valid base64url JSON')
  }
  if (header.typ !== 'dpop+jwt') {
    throw new Error(`DPoP proof typ must be dpop+jwt, got ${String(header.typ)}`)
  }
  const alg = header.alg
  if (alg !== 'ES256' && alg !== 'ES256K') {
    throw new Error(`DPoP proof alg must be ES256 or ES256K, got ${String(alg)}`)
  }
  const jwk = header.jwk as JWK | undefined
  if (!jwk || jwk.kty !== 'EC') {
    throw new Error('DPoP proof header must include an EC JWK')
  }
  if (alg === 'ES256' && jwk.crv !== 'P-256') {
    throw new Error('DPoP alg=ES256 requires JWK crv=P-256')
  }
  if (alg === 'ES256K' && jwk.crv !== 'secp256k1') {
    throw new Error('DPoP alg=ES256K requires JWK crv=secp256k1')
  }
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('DPoP JWK must have base64url x and y')
  }
  if ('d' in jwk) {
    throw new Error('DPoP JWK must not include a private component')
  }

  // Signature check.
  const signedInput = new TextEncoder().encode(
    `${encodedHeader}.${encodedPayload}`,
  )
  const msgHash = sha256(signedInput)
  const sig = base64UrlToBytes(encodedSig)
  if (sig.length !== 64) {
    throw new Error('DPoP signature must be 64 raw bytes (r||s)')
  }
  const pubBytes = jwkToUncompressedPub(jwk)
  const curve = alg === 'ES256K' ? secp256k1 : p256
  let sigOk = false
  try {
    sigOk = curve.verify(sig, msgHash, pubBytes)
  } catch {
    sigOk = false
  }
  if (!sigOk) {
    throw new Error('DPoP signature does not verify')
  }

  // Payload checks.
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(encodedPayload)),
    ) as Record<string, unknown>
  } catch {
    throw new Error('DPoP proof payload is not valid JSON')
  }

  const htm = payload['htm']
  if (typeof htm !== 'string' || htm.toUpperCase() !== httpMethod.toUpperCase()) {
    throw new Error(
      `DPoP htm mismatch: proof=${String(htm)} request=${httpMethod}`,
    )
  }
  const htu = payload['htu']
  if (typeof htu !== 'string') {
    throw new Error('DPoP htu claim missing')
  }
  if (normaliseHtu(htu) !== normaliseHtu(httpUri)) {
    throw new Error(`DPoP htu mismatch: proof=${htu} request=${httpUri}`)
  }
  const iat = payload['iat']
  if (typeof iat !== 'number') {
    throw new Error('DPoP iat claim missing or not a number')
  }
  const nowMs = args.now ?? Date.now()
  const nowSec = Math.floor(nowMs / 1000)
  if (Math.abs(nowSec - iat) > IAT_TOLERANCE_SECONDS) {
    throw new Error(
      `DPoP iat outside ±${IAT_TOLERANCE_SECONDS}s window (drift=${nowSec - iat}s)`,
    )
  }
  const jti = payload['jti']
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new Error('DPoP jti claim missing')
  }
  if (jtiCache.has(jti, nowMs)) {
    throw new Error('DPoP jti replay detected')
  }
  jtiCache.remember(jti, nowMs)

  const jkt = await calculateJwkThumbprint(jwk, 'sha256')
  if (expectedJkt && expectedJkt !== jkt) {
    throw new Error(
      `DPoP key thumbprint does not match access token cnf.jkt`,
    )
  }
  return { jkt }
}

function normaliseHtu(uri: string): string {
  // RFC 9449: compare the URI without query and fragment.
  try {
    const u = new URL(uri)
    u.search = ''
    u.hash = ''
    // Drop trailing slash for forgiveness — both '/oauth/token' and
    // '/oauth/token/' should compare equal.
    const s = u.toString()
    return s.endsWith('/') ? s.slice(0, -1) : s
  } catch {
    return uri
  }
}

function base64UrlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'))
}

function jwkToUncompressedPub(jwk: JWK): Uint8Array {
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('jwk missing x/y')
  }
  const x = base64UrlToBytes(jwk.x)
  const y = base64UrlToBytes(jwk.y)
  if (x.length !== 32 || y.length !== 32) {
    throw new Error('EC JWK x/y must each be 32 bytes')
  }
  const out = new Uint8Array(65)
  out[0] = 0x04
  out.set(x, 1)
  out.set(y, 33)
  return out
}
