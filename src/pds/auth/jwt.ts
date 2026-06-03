// JWT issuance and verification.
//
// Two token kinds: access (short-lived, used on every XRPC call) and refresh
// (long-lived, used to mint a new access). Both are HS256-signed with the
// PDS_JWT_SECRET. Access tokens are stateless to validate; refresh tokens
// have their `jti` claim recorded in the database so individual sessions can
// be revoked (logout, password change, suspicion).
//
// See chapter 13 — Authentication.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { randomBytes } from 'node:crypto'
import { getConfig } from '~/lib/config'

export type TokenScope = 'com.atproto.access' | 'com.atproto.refresh'

export type AccessClaims = JWTPayload & {
  scope: 'com.atproto.access'
  sub: string // user DID
  jti: string
}

export type RefreshClaims = JWTPayload & {
  scope: 'com.atproto.refresh'
  sub: string
  jti: string
}

const ACCESS_TTL_SECONDS = 2 * 60 * 60 // 2 hours
const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60 // 60 days
const SERVICE_TTL_SECONDS = 60 // cross-PDS auth — keep this tight
// Hard cap when the caller opts into `unsafeLongLived`. Migration is the
// only flow that needs more than 60s (the user has to drive the
// destination side end-to-end with the token in hand); one hour is
// generous and still narrow enough that a leaked token has a short blast
// radius. Chapter 20.
const SERVICE_TTL_SECONDS_LONG = 60 * 60 // 1 hour

export async function signAccessToken(did: string): Promise<{
  jwt: string
  jti: string
  exp: number
}> {
  const cfg = getConfig()
  const jti = randomJti()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ACCESS_TTL_SECONDS
  const jwt = await new SignJWT({
    scope: 'com.atproto.access',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(cfg.serviceDid)
    .setAudience(cfg.serviceDid)
    .setSubject(did)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(cfg.jwtSecret)
  return { jwt, jti, exp }
}

export async function signRefreshToken(did: string): Promise<{
  jwt: string
  jti: string
  exp: number
}> {
  const cfg = getConfig()
  const jti = randomJti()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + REFRESH_TTL_SECONDS
  const jwt = await new SignJWT({
    scope: 'com.atproto.refresh',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'refresh+jwt' })
    .setIssuer(cfg.serviceDid)
    .setAudience(cfg.serviceDid)
    .setSubject(did)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(cfg.jwtSecret)
  return { jwt, jti, exp }
}

export type ServiceClaims = JWTPayload & {
  iss: string // the user DID
  aud: string // the target service DID
  lxm?: string // method NSID this token is scoped to
  jti: string
}

/** Mint a short-lived service token authorizing one DID's session to talk
 *  to another service (typically: the migrating user authorizing the new PDS
 *  to call `getRepo` on the old one).
 *
 *  ⚠️ The atproto spec uses ES256K signatures with the user's signing key so
 *  the receiver verifies against the user's DID document. We sign with HS256
 *  using the shared PDS_JWT_SECRET — fine for self-issued tokens this PDS
 *  also verifies, useless across the network. Chapter 20 covers the
 *  divergence. */
export async function signServiceToken(args: {
  did: string
  aud: string
  lxm?: string
  expiresInSeconds?: number
  /** Opt-in: allow TTLs above the 60s default, capped at one hour. Only
   *  the migration entry point (`com.atproto.server.requestAccountMigrate`)
   *  uses this — the migrating user needs to carry the token across to
   *  the destination PDS and drive a multi-step ingest. Everything else
   *  on this PDS sticks to the short default. */
  unsafeLongLived?: boolean
}): Promise<{ jwt: string; jti: string; exp: number }> {
  const cfg = getConfig()
  const cap = args.unsafeLongLived
    ? SERVICE_TTL_SECONDS_LONG
    : SERVICE_TTL_SECONDS
  const ttl = Math.min(
    Math.max(1, args.expiresInSeconds ?? SERVICE_TTL_SECONDS),
    cap,
  )
  const jti = randomJti()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttl
  const builder = new SignJWT({
    ...(args.lxm ? { lxm: args.lxm } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(args.did)
    .setAudience(args.aud)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
  const jwt = await builder.sign(cfg.jwtSecret)
  return { jwt, jti, exp }
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const cfg = getConfig()
  const { payload } = await jwtVerify(token, cfg.jwtSecret, {
    issuer: cfg.serviceDid,
    audience: cfg.serviceDid,
  })
  if (payload.scope !== 'com.atproto.access') {
    throw new Error(`wrong token scope: ${payload.scope}`)
  }
  return payload as AccessClaims
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims> {
  const cfg = getConfig()
  const { payload } = await jwtVerify(token, cfg.jwtSecret, {
    issuer: cfg.serviceDid,
    audience: cfg.serviceDid,
  })
  if (payload.scope !== 'com.atproto.refresh') {
    throw new Error(`wrong token scope: ${payload.scope}`)
  }
  return payload as RefreshClaims
}

function randomJti(): string {
  return randomBytes(16).toString('base64url')
}

// ─── OAuth tokens ──────────────────────────────────────────────────────────
//
// The OAuth surface (chapter 21) mints its own access + refresh JWTs signed
// with the PDS's OAuth signing key (ES256K, asymmetric — public half is on
// /oauth/jwks). They live in `~/pds/oauth/tokens` so the chapter-21 code is
// self-contained; we re-export the signer here so callers have a single
// place to look for "how do I mint a token for a session?"
//
// See chapter 21 — OAuth.
export {
  signOauthAccessToken,
  signOauthRefreshToken,
  consumeOauthRefreshToken,
  verifyOauthAccessToken,
} from '~/pds/oauth/tokens'
