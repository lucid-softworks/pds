// Behavior contract for JWT issuance / verification.
//
// Access and refresh tokens share the HS256 key but live in different
// `scope` namespaces. Cross-scope verification must fail closed —
// otherwise a phished refresh token could authenticate as an access token,
// or vice versa.

import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { getConfig } from '~/lib/config'
import {
  signAccessToken,
  signRefreshToken,
  signServiceToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './jwt'

const DID = 'did:plc:fakedidfakedidfakedidfak'

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips: verified claims include the DID', async () => {
    const { jwt, jti, exp } = await signAccessToken(DID)
    expect(jwt.split('.')).toHaveLength(3)
    const claims = await verifyAccessToken(jwt)
    expect(claims.sub).toBe(DID)
    expect(claims.scope).toBe('com.atproto.access')
    expect(claims.jti).toBe(jti)
    expect(claims.exp).toBe(exp)
  })
})

describe('signRefreshToken / verifyRefreshToken', () => {
  it('round-trips with the refresh scope', async () => {
    const { jwt } = await signRefreshToken(DID)
    const claims = await verifyRefreshToken(jwt)
    expect(claims.sub).toBe(DID)
    expect(claims.scope).toBe('com.atproto.refresh')
  })
})

describe('cross-scope rejection', () => {
  it('verifyRefreshToken throws on an access-scoped token', async () => {
    const { jwt } = await signAccessToken(DID)
    await expect(verifyRefreshToken(jwt)).rejects.toThrow(/wrong token scope/)
  })

  it('verifyAccessToken throws on a refresh-scoped token', async () => {
    const { jwt } = await signRefreshToken(DID)
    await expect(verifyAccessToken(jwt)).rejects.toThrow(/wrong token scope/)
  })
})

describe('expired tokens', () => {
  it('verifyAccessToken throws for a token whose exp is in the past', async () => {
    // Mint a token by hand so we can backdate its exp without waiting two
    // hours. The signature still uses the configured secret.
    const cfg = getConfig()
    const past = Math.floor(Date.now() / 1000) - 3600
    const jwt = await new SignJWT({ scope: 'com.atproto.access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(cfg.serviceDid)
      .setAudience(cfg.serviceDid)
      .setSubject(DID)
      .setJti('expired-jti')
      .setIssuedAt(past - 1)
      .setExpirationTime(past)
      .sign(cfg.jwtSecret)
    await expect(verifyAccessToken(jwt)).rejects.toThrow()
  })
})

describe('signServiceToken', () => {
  it('round-trips with the right aud / lxm', async () => {
    const { jwt } = await signServiceToken({
      did: DID,
      aud: 'did:web:other.example',
      lxm: 'com.atproto.sync.getRepo',
    })
    // We don't have a public verifyServiceToken; decode the payload to check
    // the claims using `jose` directly. Re-using verifyAccessToken would
    // reject because iss != serviceDid.
    const claims = JSON.parse(
      Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'),
    )
    expect(claims.iss).toBe(DID)
    expect(claims.aud).toBe('did:web:other.example')
    expect(claims.lxm).toBe('com.atproto.sync.getRepo')
    // Service tokens are capped at 60 seconds by the implementation.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60)
  })
})
