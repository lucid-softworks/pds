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
