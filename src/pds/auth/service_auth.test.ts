// Behavior contract for the ES256K service-auth minter.
//
// The DB-backed `mintServiceAuth` is exercised by integration tests that
// stand up a real account (see tests/integration/proxy.test.ts and
// migration.test.ts). The pure-input `mintServiceAuthWithKey` we cover
// here: given a private key, produces a JWT verifiable by the matching
// public key, with the expected claim shape and TTL caps.

import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { decodeJwt, jwtVerify, importJWK } from 'jose'
import { secp256k1 } from '@noble/curves/secp256k1'

import { mintServiceAuthWithKey } from './service_auth'

function makeKeypair() {
  const priv = secp256k1.utils.randomPrivateKey()
  const privHex = Buffer.from(priv).toString('hex')
  const pub = secp256k1.getPublicKey(priv, false)
  const publicJwk = {
    kty: 'EC' as const,
    crv: 'secp256k1' as const,
    x: Buffer.from(pub.slice(1, 33)).toString('base64url'),
    y: Buffer.from(pub.slice(33, 65)).toString('base64url'),
    alg: 'ES256K' as const,
    use: 'sig' as const,
  }
  return { privHex, publicJwk }
}

describe('mintServiceAuthWithKey', () => {
  it('mints a JWT with the expected claims and ES256K header', async () => {
    const { privHex } = makeKeypair()
    const { jwt, jti, exp } = await mintServiceAuthWithKey({
      did: 'did:plc:abc',
      signingKeyPriv: privHex,
      audience: 'did:web:api.bsky.app',
      lxm: 'app.bsky.actor.getProfile',
    })
    const claims = decodeJwt(jwt)
    expect(claims.iss).toBe('did:plc:abc')
    expect(claims.aud).toBe('did:web:api.bsky.app')
    expect(claims.lxm).toBe('app.bsky.actor.getProfile')
    expect(claims.jti).toBe(jti)
    expect(claims.exp).toBe(exp)
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(60)
  })

  it('omits lxm when none is supplied', async () => {
    const { privHex } = makeKeypair()
    const { jwt } = await mintServiceAuthWithKey({
      did: 'did:plc:abc',
      signingKeyPriv: privHex,
      audience: 'did:web:dest.example',
    })
    expect(decodeJwt(jwt).lxm).toBeUndefined()
  })

  it('caps TTL at 60s by default even when caller asks for more', async () => {
    const { privHex } = makeKeypair()
    const { jwt } = await mintServiceAuthWithKey({
      did: 'did:plc:abc',
      signingKeyPriv: privHex,
      audience: 'did:web:dest.example',
      expiresInSeconds: 3600,
    })
    const claims = decodeJwt(jwt)
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(60)
  })

  it('allows up to 1 hour when unsafeLongLived is set (migration entry point)', async () => {
    const { privHex } = makeKeypair()
    const { jwt } = await mintServiceAuthWithKey({
      did: 'did:plc:abc',
      signingKeyPriv: privHex,
      audience: 'did:web:dest.example',
      expiresInSeconds: 3600,
      unsafeLongLived: true,
    })
    const claims = decodeJwt(jwt)
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600)
  })

  it('is verifiable with the matching public key', async () => {
    const { privHex, publicJwk } = makeKeypair()
    const { jwt } = await mintServiceAuthWithKey({
      did: 'did:plc:abc',
      signingKeyPriv: privHex,
      audience: 'did:web:api.bsky.app',
      lxm: 'app.bsky.actor.getProfile',
    })
    const pubKey = await importJWK(publicJwk, 'ES256K')
    const { payload, protectedHeader } = await jwtVerify(jwt, pubKey, {
      issuer: 'did:plc:abc',
      audience: 'did:web:api.bsky.app',
    })
    expect(protectedHeader.alg).toBe('ES256K')
    expect(payload.lxm).toBe('app.bsky.actor.getProfile')
  })

  it('fails verification when signed with the wrong key', async () => {
    const a = makeKeypair()
    const b = makeKeypair()
    const { jwt } = await mintServiceAuthWithKey({
      did: 'did:plc:abc',
      signingKeyPriv: a.privHex,
      audience: 'did:web:api.bsky.app',
      lxm: 'app.bsky.actor.getProfile',
    })
    const wrongKey = await importJWK(b.publicJwk, 'ES256K')
    await expect(jwtVerify(jwt, wrongKey)).rejects.toThrow()
  })
})
