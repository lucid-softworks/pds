// Behavior contract for secp256k1 key handling.
//
// Repo commits, PLC genesis operations, and service auth all sign with these
// keys — a broken keypair would silently corrupt every signature. We pin:
//   - sign / verify round-trip
//   - wrong-key verification returns `false` (not throws)
//   - public-key derivation from a private key is deterministic
//   - Multikey decode is a left inverse of encode (via re-derivation)

import { describe, expect, it } from 'vitest'
import {
  generateKeypair,
  publicKeyFromPrivate,
  signBytes,
  signHash,
  verifyBytes,
  verifySig,
} from './keys'

describe('generateKeypair', () => {
  it('returns a keypair whose private key derives the same public key', () => {
    const kp = generateKeypair()
    const derived = publicKeyFromPrivate(kp.privateKeyHex)
    expect(derived.publicKeyMultibase).toBe(kp.publicKeyMultibase)
    expect(derived.didKey).toBe(kp.didKey)
  })

  it('emits a did:key with multibase z prefix', () => {
    const kp = generateKeypair()
    expect(kp.didKey.startsWith('did:key:z')).toBe(true)
    expect(kp.publicKeyMultibase.startsWith('z')).toBe(true)
  })
})

describe('signBytes / verifyBytes', () => {
  it('round-trips a signature over arbitrary bytes', () => {
    const kp = generateKeypair()
    const msg = new TextEncoder().encode('hello, world')
    const sig = signBytes(kp.privateKeyHex, msg)
    expect(verifyBytes(kp.publicKeyMultibase, msg, sig)).toBe(true)
  })

  it('returns false for a verification with the wrong public key', () => {
    const a = generateKeypair()
    const b = generateKeypair()
    const msg = new TextEncoder().encode('signed by A')
    const sig = signBytes(a.privateKeyHex, msg)
    // Use B's pubkey — same multikey shape, different curve point.
    const ok = verifyBytes(b.publicKeyMultibase, msg, sig)
    expect(ok).toBe(false)
  })

  it('returns false for a tampered message', () => {
    const kp = generateKeypair()
    const msg = new TextEncoder().encode('original')
    const sig = signBytes(kp.privateKeyHex, msg)
    const tampered = new TextEncoder().encode('tampered')
    expect(verifyBytes(kp.publicKeyMultibase, tampered, sig)).toBe(false)
  })
})

describe('signHash / verifySig', () => {
  it('rejects a non-32-byte hash', () => {
    const kp = generateKeypair()
    expect(() =>
      signHash(kp.privateKeyHex, new Uint8Array(31)),
    ).toThrow(/32-byte hash/)
  })

  it('round-trips a signature over an exact 32-byte hash', () => {
    const kp = generateKeypair()
    const hash = new Uint8Array(32).fill(7)
    const sig = signHash(kp.privateKeyHex, hash)
    expect(sig).toHaveLength(64) // compact form
    expect(verifySig(kp.publicKeyMultibase, hash, sig)).toBe(true)
  })

  it('returns false for a malformed signature length', () => {
    const kp = generateKeypair()
    const hash = new Uint8Array(32).fill(7)
    expect(verifySig(kp.publicKeyMultibase, hash, new Uint8Array(50))).toBe(false)
  })
})

describe('publicKeyFromPrivate', () => {
  it('is deterministic for the same private key', () => {
    const kp = generateKeypair()
    const a = publicKeyFromPrivate(kp.privateKeyHex)
    const b = publicKeyFromPrivate(kp.privateKeyHex)
    expect(a.publicKeyMultibase).toBe(b.publicKeyMultibase)
    expect(a.didKey).toBe(b.didKey)
  })
})
