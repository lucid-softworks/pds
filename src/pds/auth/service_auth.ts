// Service-auth JWT minting — the canonical cross-service authentication
// primitive in atproto.
//
// A service-auth token is a short-lived JWT issued by one party (the
// caller) and addressed to another (the audience service). The token's
// `iss` is the caller's DID; the receiver verifies the signature against
// the caller's *published* repo signing key (the one in the DID
// document, the same one the user's PDS uses to sign commits). No shared
// secret, no out-of-band trust setup — every PDS can mint, every
// service can verify, identity is the trust anchor.
//
// This is what the AppView's `authVerifier.standard` expects on
// `app.bsky.*` calls that route via service auth (e.g.
// `app.bsky.ageassurance.begin`), what other PDSes expect for
// migration handshakes, and what the `Atproto-Proxy` proxy path mints
// when forwarding `app.bsky.*` calls to the AppView on the user's
// behalf.
//
// The signature is ES256K — secp256k1 with a low-S DER constraint,
// JWT-encoded per the JOSE rules. We import the user's private scalar
// (32 bytes hex) into a jose `KeyLike` via JWK and sign through jose's
// `SignJWT`. The private key never leaves the process; the public half
// is derived deterministically from it during JWK construction.
//
// History: this module replaces an earlier HS256-with-shared-secret
// implementation (`signServiceToken` in `~/pds/auth/jwt.ts`) that
// shipped as a deliberate teaching-port shortcut. Once the
// `Atproto-Proxy` proxy path landed (chapter 17) and the AppView
// started rejecting cross-service tokens we couldn't verify, the
// shortcut had to go. The proxy already minted ES256K tokens via
// `mintProxyServiceAuth` in `~/pds/xrpc/proxy.ts`; this module is the
// shared home so both the proxy and the `getServiceAuth` /
// `requestAccountMigrate` handlers go through one verifier-friendly
// path.
//
// See chapter 13 — Authentication, and chapter 17 — PDS vs AppView vs
// Relay.

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { SignJWT, importJWK, type KeyLike } from 'jose'
import { secp256k1 } from '@noble/curves/secp256k1'
import { eq } from 'drizzle-orm'

import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { getKeyWrapper } from './key_wrap'

/** Cross-service tokens are intentionally short-lived. 60s is enough to
 *  cover the time between mint and the receiver's verify; we don't ever
 *  want a captured token to be replayable beyond the next round trip. */
const DEFAULT_TTL_SECONDS = 60

/** Migration carries a token across the network to the destination PDS,
 *  which then uses it to drive a multi-step ingest. The window has to be
 *  wide enough to clear inbox lag plus the destination's processing
 *  time. 1h is the official PDS's choice; we match it. */
const LONG_TTL_SECONDS = 60 * 60

export type ServiceAuthClaims = {
  /** The DID of the account on whose behalf the token is being minted.
   *  This MUST match an active row in the local `accounts` table — we
   *  need the private signing key to sign. */
  did: string
  /** The target DID. Receivers gate on this — a token addressed to a
   *  different service should fail verification on the wrong receiver
   *  even if its signature checks out. */
  audience: string
  /** Optional `lxm` claim. When set, the receiver scopes the token to a
   *  single XRPC method NSID; calling any other method with the same
   *  token fails. Strongly recommended. */
  lxm?: string
  /** TTL override. Capped at 60s by default and at 1h with
   *  `unsafeLongLived: true`. */
  expiresInSeconds?: number
  /** Opt-in to the longer 1h cap. Only the migration entry point
   *  (`com.atproto.server.requestAccountMigrate`) should use this — the
   *  migrating user has to carry the token across to the destination
   *  PDS and drive a multi-step ingest. Everything else (AppView calls,
   *  proxy forwarding) sticks to the short default. */
  unsafeLongLived?: boolean
}

/** Look up the signing key on the local account row, unwrap it through
 *  the configured `KeyWrapper`, sign an ES256K JWT with the requested
 *  claims, and return the bearer string. Throws if the DID is unknown
 *  locally or the unwrap fails. */
export async function mintServiceAuth(
  claims: ServiceAuthClaims,
): Promise<{ jwt: string; jti: string; exp: number }> {
  const cap = claims.unsafeLongLived ? LONG_TTL_SECONDS : DEFAULT_TTL_SECONDS
  const ttl = Math.min(
    Math.max(1, claims.expiresInSeconds ?? DEFAULT_TTL_SECONDS),
    cap,
  )
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttl
  const jti = randomBytes(16).toString('base64url')

  const signingKeyPriv = await loadSigningKey(claims.did)
  const key = await importSigningKey(signingKeyPriv)

  const builder = new SignJWT(claims.lxm ? { lxm: claims.lxm } : {})
    .setProtectedHeader({ alg: 'ES256K', typ: 'JWT' })
    .setIssuer(claims.did)
    .setAudience(claims.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)

  const jwt = await builder.sign(key)
  return { jwt, jti, exp }
}

/** Lower-level shape: caller already has the unwrapped private key in
 *  hand (e.g. inside a handler that just unwrapped it for another
 *  reason). Skips the DB read. Same signing contract. */
export async function mintServiceAuthWithKey(args: {
  did: string
  signingKeyPriv: string
  audience: string
  lxm?: string
  expiresInSeconds?: number
  unsafeLongLived?: boolean
}): Promise<{ jwt: string; jti: string; exp: number }> {
  const cap = args.unsafeLongLived ? LONG_TTL_SECONDS : DEFAULT_TTL_SECONDS
  const ttl = Math.min(
    Math.max(1, args.expiresInSeconds ?? DEFAULT_TTL_SECONDS),
    cap,
  )
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttl
  const jti = randomBytes(16).toString('base64url')

  const key = await importSigningKey(args.signingKeyPriv)

  const builder = new SignJWT(args.lxm ? { lxm: args.lxm } : {})
    .setProtectedHeader({ alg: 'ES256K', typ: 'JWT' })
    .setIssuer(args.did)
    .setAudience(args.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)

  const jwt = await builder.sign(key)
  return { jwt, jti, exp }
}

async function loadSigningKey(did: string): Promise<string> {
  const row = (
    await db
      .select({ signingKeyPriv: accounts.signingKeyPriv })
      .from(accounts)
      .where(eq(accounts.did, did))
      .limit(1)
  )[0]
  if (!row) {
    throw new Error(`no account for ${did}`)
  }
  return await getKeyWrapper().unwrap(row.signingKeyPriv)
}

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
