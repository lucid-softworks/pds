// OAuth access + refresh token minting / verification.
//
// Both tokens are ES256K-signed JWTs using the PDS's OAuth signing key (see
// `keys.ts`). They are distinct in two ways from the chapter-13 session
// tokens:
//
//   1. They are signed with an asymmetric key — the public half is published
//      at /oauth/jwks so OAuth clients can verify without contacting us.
//   2. They are DPoP-bound: the access token carries `cnf.jkt` (the SHA-256
//      thumbprint of the client's DPoP key), and the refresh row records the
//      same thumbprint in `dpop_jkt` so a refresh-grant request must come
//      with a matching DPoP proof.
//
// Refresh tokens are persisted in the same `refresh_tokens` table as session
// tokens, with `kind='oauth'`, `dpop_jkt` set, and `scope` set. See chapter
// 21 — OAuth.

import { eq } from 'drizzle-orm'
import { hexToBytes } from '@noble/hashes/utils'
import { secp256k1 } from '@noble/curves/secp256k1'
import { SignJWT, jwtVerify, importJWK, type JWTPayload, type KeyLike } from 'jose'
import { randomBytes } from 'node:crypto'

import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { refreshTokens } from '~/lib/db/schema'
import { getOauthSigningKey } from './keys'

const ACCESS_TTL_SECONDS_DEFAULT = 30 * 60 // 30 minutes
const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60 // 60 days, matching chapter 13

let signingKeyCache: { kid: string; privateKey: KeyLike } | null = null
let verifyKeyCache: { kid: string; publicKey: KeyLike } | null = null

async function getSigningKey(): Promise<{ kid: string; key: KeyLike }> {
  if (signingKeyCache) {
    return { kid: signingKeyCache.kid, key: signingKeyCache.privateKey }
  }
  const k = await getOauthSigningKey()
  // jose's importJWK with d= populated gives us a private CryptoKey/KeyObject
  // we can sign with. Reconstruct the private JWK from the hex scalar.
  const privBytes = hexToBytes(k.privateKeyHex)
  const pub = secp256k1.getPublicKey(privBytes, false)
  const x = pub.slice(1, 33)
  const y = pub.slice(33, 65)
  const privateJwk = {
    kty: 'EC',
    crv: 'secp256k1',
    x: Buffer.from(x).toString('base64url'),
    y: Buffer.from(y).toString('base64url'),
    d: Buffer.from(privBytes).toString('base64url'),
    alg: 'ES256K',
    use: 'sig',
    kid: k.kid,
  }
  const privateKey = (await importJWK(privateJwk, 'ES256K')) as KeyLike
  signingKeyCache = { kid: k.kid, privateKey }
  return { kid: k.kid, key: privateKey }
}

async function getVerifyKey(): Promise<{ kid: string; key: KeyLike }> {
  if (verifyKeyCache) {
    return { kid: verifyKeyCache.kid, key: verifyKeyCache.publicKey }
  }
  const k = await getOauthSigningKey()
  const publicKey = (await importJWK(k.publicJwk, 'ES256K')) as KeyLike
  verifyKeyCache = { kid: k.kid, publicKey }
  return { kid: k.kid, key: publicKey }
}

/** Test hook — drop cached imported keys after env changes. */
export function _resetOauthTokenKeyCache(): void {
  signingKeyCache = null
  verifyKeyCache = null
}

export type OauthAccessClaims = JWTPayload & {
  scope: string
  sub: string
  jti: string
  cnf: { jkt: string }
}

export type OauthRefreshClaims = JWTPayload & {
  scope: string
  sub: string
  jti: string
  cnf: { jkt: string }
  /** Distinguishes refresh tokens from access tokens at verify time. */
  token_kind: 'refresh'
}

/** Mint a DPoP-bound OAuth access token. */
export async function signOauthAccessToken(args: {
  did: string
  scope: string
  dpopJkt: string
  audience?: string
  expiresInSeconds?: number
}): Promise<{ jwt: string; jti: string; exp: number }> {
  const cfg = getConfig()
  const { kid, key } = await getSigningKey()
  const ttl = args.expiresInSeconds ?? ACCESS_TTL_SECONDS_DEFAULT
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttl
  const jti = randomJti()
  const jwt = await new SignJWT({
    scope: args.scope,
    cnf: { jkt: args.dpopJkt },
  })
    .setProtectedHeader({ alg: 'ES256K', typ: 'at+jwt', kid })
    .setIssuer(cfg.publicUrl)
    .setAudience(args.audience ?? cfg.serviceDid)
    .setSubject(args.did)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key)
  return { jwt, jti, exp }
}

/** Mint an OAuth refresh token. Persists a row in `refresh_tokens` with
 *  kind='oauth', dpop_jkt, and scope so the token endpoint can re-issue an
 *  access token bound to the same client key on the next call. */
export async function signOauthRefreshToken(args: {
  did: string
  dpopJkt: string
  scope: string
}): Promise<{ jwt: string; jti: string; exp: number }> {
  const cfg = getConfig()
  const { kid, key } = await getSigningKey()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + REFRESH_TTL_SECONDS
  const jti = randomJti()
  const jwt = await new SignJWT({
    scope: args.scope,
    cnf: { jkt: args.dpopJkt },
    token_kind: 'refresh',
  })
    .setProtectedHeader({ alg: 'ES256K', typ: 'refresh+jwt', kid })
    .setIssuer(cfg.publicUrl)
    .setAudience(cfg.serviceDid)
    .setSubject(args.did)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key)
  await db.insert(refreshTokens).values({
    jti,
    did: args.did,
    expiresAt: new Date(exp * 1000),
    appPasswordName: null,
    kind: 'oauth',
    dpopJkt: args.dpopJkt,
    scope: args.scope,
  })
  return { jwt, jti, exp }
}

/** Validate an OAuth refresh token: signature, claims, row presence, and
 *  that the provided DPoP key thumbprint matches what was bound to the row.
 *  Does NOT delete the row — the token endpoint rotates inside a transaction
 *  using the returned details. Throws on any failure. */
export async function validateOauthRefreshToken(args: {
  jwt: string
  dpopJkt: string
}): Promise<{
  jti: string
  did: string
  scope: string
}> {
  const cfg = getConfig()
  const { key } = await getVerifyKey()
  const { payload } = await jwtVerify(args.jwt, key, {
    issuer: cfg.publicUrl,
    audience: cfg.serviceDid,
  })
  const claims = payload as OauthRefreshClaims
  if (claims.token_kind !== 'refresh') {
    throw new Error('not an OAuth refresh token')
  }
  if (!claims.cnf || claims.cnf.jkt !== args.dpopJkt) {
    throw new Error('DPoP key thumbprint does not match refresh token cnf.jkt')
  }
  if (typeof claims.jti !== 'string' || typeof claims.sub !== 'string') {
    throw new Error('refresh token missing jti / sub')
  }
  const rows = await db
    .select({
      jti: refreshTokens.jti,
      did: refreshTokens.did,
      kind: refreshTokens.kind,
      dpopJkt: refreshTokens.dpopJkt,
      scope: refreshTokens.scope,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.jti, claims.jti))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new Error('refresh token revoked or already used')
  }
  if (row.kind !== 'oauth') {
    throw new Error('refresh token is not an OAuth token')
  }
  if (row.dpopJkt !== args.dpopJkt) {
    // Belt-and-braces — the JWT cnf.jkt check should have caught this.
    throw new Error('DPoP key thumbprint does not match stored row')
  }
  return {
    jti: row.jti,
    did: row.did,
    scope: row.scope ?? claims.scope,
  }
}

/** Verify + delete an OAuth refresh token row, returning the granted details
 *  so the caller can mint a rotated pair. The DPoP thumbprint MUST match
 *  what's on the row (RFC 9449 §5). */
export async function consumeOauthRefreshToken(args: {
  jwt: string
  dpopJkt: string
}): Promise<{ did: string; scope: string }> {
  const v = await validateOauthRefreshToken(args)
  // Best-effort single-use: delete the row by jti. A racing duplicate refresh
  // will see the row gone and fail validate above. We don't transact here
  // because the new row's insert (in signOauthRefreshToken) is independent;
  // worst case a crash between delete + insert leaves the user without a
  // refresh token, which they recover from by logging in again.
  const deleted = await db
    .delete(refreshTokens)
    .where(eq(refreshTokens.jti, v.jti))
  void deleted
  return { did: v.did, scope: v.scope }
}

/** Verify + return claims of an OAuth access token. Doesn't check `cnf.jkt`
 *  itself — call sites pair this with `verifyDpopProof({ expectedJkt: ... })`
 *  so the proof binding is enforced on the live request. */
export async function verifyOauthAccessToken(jwt: string): Promise<{
  did: string
  scope: string
  jkt: string
  jti: string
  exp: number
}> {
  const cfg = getConfig()
  const { key } = await getVerifyKey()
  const { payload } = await jwtVerify(jwt, key, {
    issuer: cfg.publicUrl,
  })
  const claims = payload as OauthAccessClaims
  if (typeof claims.sub !== 'string') throw new Error('access token missing sub')
  if (typeof claims.scope !== 'string') throw new Error('access token missing scope')
  if (!claims.cnf || typeof claims.cnf.jkt !== 'string') {
    throw new Error('access token missing cnf.jkt')
  }
  if (typeof claims.jti !== 'string' || typeof claims.exp !== 'number') {
    throw new Error('access token missing jti / exp')
  }
  return {
    did: claims.sub,
    scope: claims.scope,
    jkt: claims.cnf.jkt,
    jti: claims.jti,
    exp: claims.exp,
  }
}

function randomJti(): string {
  return randomBytes(16).toString('base64url')
}
