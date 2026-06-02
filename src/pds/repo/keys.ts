// k256 (secp256k1) keypair management for repo signing and PLC rotation.
//
// The AT Protocol mandates low-S ECDSA signatures on the secp256k1 curve.
// Public keys are encoded as Multikey: multicodec(0xe7) + compressed pubkey,
// multibase z (base58btc). The same encoding is reused for did:key.
//
// We use @noble/curves — audited pure-JS, no native deps. See chapter 07.

import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { base58btc } from 'multiformats/bases/base58'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

// Multicodec varint prefix for secp256k1-pub (0xe7). The varint encoding of
// 0xe7 is the two bytes 0xe7 0x01 because the value exceeds 7 bits.
const SECP256K1_PUB_PREFIX = new Uint8Array([0xe7, 0x01])

export type Keypair = {
  /** 32-byte private scalar, hex-encoded. */
  privateKeyHex: string
  /** 33-byte compressed public key, Multikey-encoded (`z...`). */
  publicKeyMultibase: string
  /** Same public key as did:key: form. */
  didKey: string
}

export function generateKeypair(): Keypair {
  const priv = secp256k1.utils.randomPrivateKey()
  const pub = secp256k1.getPublicKey(priv, true) // compressed
  return {
    privateKeyHex: bytesToHex(priv),
    publicKeyMultibase: encodeMultikey(pub),
    didKey: 'did:key:' + encodeMultikey(pub),
  }
}

export function publicKeyFromPrivate(privateKeyHex: string): {
  publicKeyMultibase: string
  didKey: string
} {
  const priv = hexToBytes(privateKeyHex)
  const pub = secp256k1.getPublicKey(priv, true)
  return {
    publicKeyMultibase: encodeMultikey(pub),
    didKey: 'did:key:' + encodeMultikey(pub),
  }
}

/** Sign a 32-byte hash with a low-S ECDSA signature (64-byte compact). */
export function signHash(privateKeyHex: string, hash: Uint8Array): Uint8Array {
  if (hash.length !== 32) {
    throw new Error(`expected 32-byte hash, got ${hash.length}`)
  }
  const sig = secp256k1.sign(hash, hexToBytes(privateKeyHex), { lowS: true })
  return sig.toCompactRawBytes()
}

/** Verify a 64-byte compact signature against a 32-byte hash. */
export function verifySig(
  publicKeyMultibase: string,
  hash: Uint8Array,
  sig: Uint8Array,
): boolean {
  if (sig.length !== 64) return false
  if (hash.length !== 32) return false
  const pubBytes = decodeMultikey(publicKeyMultibase)
  try {
    return secp256k1.verify(sig, hash, pubBytes, { lowS: true })
  } catch {
    return false
  }
}

/** Sign arbitrary bytes (hashes them first with SHA-256). */
export function signBytes(privateKeyHex: string, bytes: Uint8Array): Uint8Array {
  return signHash(privateKeyHex, sha256(bytes))
}

export function verifyBytes(
  publicKeyMultibase: string,
  bytes: Uint8Array,
  sig: Uint8Array,
): boolean {
  return verifySig(publicKeyMultibase, sha256(bytes), sig)
}

function encodeMultikey(compressedPubKey: Uint8Array): string {
  const combined = new Uint8Array(
    SECP256K1_PUB_PREFIX.length + compressedPubKey.length,
  )
  combined.set(SECP256K1_PUB_PREFIX, 0)
  combined.set(compressedPubKey, SECP256K1_PUB_PREFIX.length)
  return base58btc.encode(combined)
}

function decodeMultikey(multikey: string): Uint8Array {
  if (!multikey.startsWith('z')) {
    throw new Error(`expected multibase z prefix, got: ${multikey.slice(0, 4)}`)
  }
  const bytes = base58btc.decode(multikey)
  if (
    bytes[0] !== SECP256K1_PUB_PREFIX[0] ||
    bytes[1] !== SECP256K1_PUB_PREFIX[1]
  ) {
    throw new Error('not a secp256k1 multikey')
  }
  return bytes.slice(SECP256K1_PUB_PREFIX.length)
}
