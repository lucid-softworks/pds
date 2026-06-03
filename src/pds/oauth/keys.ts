// The PDS's OAuth signing key.
//
// This is a single ES256K (secp256k1) keypair owned by the PDS itself, used
// to sign OAuth access and refresh JWTs and published at /oauth/jwks so OAuth
// clients can verify the tokens we issue. It is intentionally **not** the
// same as any per-account repo signing key:
//
// - Per-account keys (`accounts.signing_key_priv`) sign Merkle-tree commits
//   on a user's behalf. One key per account; lifetime = account lifetime.
// - This OAuth key signs JWTs on the PDS's behalf as an OAuth authorization
//   server. One key per deployment; lifetime = deployment lifetime.
//
// We re-use the secp256k1 curve from `@noble/curves` so the existing
// keys-handling primitives apply, but we present the public key as a JWK
// (the OAuth wire format) rather than a Multikey.
//
// See chapter 21 — OAuth.

import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes } from '@noble/hashes/utils'
import { calculateJwkThumbprint, type JWK } from 'jose'
import { getConfig } from '~/lib/config'

export type OauthSigningKey = {
  /** 32-byte k256 private scalar, hex-encoded. */
  privateKeyHex: string
  /** Public key as a JWK with kid + alg + use baked in. */
  publicJwk: JWK
  /** RFC 7638 thumbprint of the canonical JWK, also used as `kid`. */
  kid: string
}

let cached: OauthSigningKey | null = null

/** Load the PDS's OAuth signing key from env. Throws when unset — generate
 *  one with:
 *
 *    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 *  and put it in PDS_OAUTH_SIGNING_KEY. */
export async function getOauthSigningKey(): Promise<OauthSigningKey> {
  if (cached) return cached
  const cfg = getConfig()
  if (!cfg.oauthSigningKey) {
    throw new Error(
      'PDS_OAUTH_SIGNING_KEY is not set — the OAuth surface is disabled. ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    )
  }
  const priv = hexToBytes(cfg.oauthSigningKey)
  // Uncompressed = 0x04 || X(32) || Y(32). DPoP / JWK want X and Y separately.
  const pub = secp256k1.getPublicKey(priv, false)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('unexpected secp256k1 public key encoding')
  }
  const x = pub.slice(1, 33)
  const y = pub.slice(33, 65)
  // The canonical JWK ordering for thumbprinting is crv, kty, x, y — jose's
  // calculateJwkThumbprint handles that for us.
  const baseJwk: JWK = {
    kty: 'EC',
    crv: 'secp256k1',
    x: bytesToBase64Url(x),
    y: bytesToBase64Url(y),
  }
  const kid = await calculateJwkThumbprint(baseJwk, 'sha256')
  cached = {
    privateKeyHex: cfg.oauthSigningKey,
    publicJwk: {
      ...baseJwk,
      alg: 'ES256K',
      use: 'sig',
      kid,
    },
    kid,
  }
  return cached
}

/** Test/dev hook: drop the in-process cache so a different env var reload
 *  picks up. Not exported as part of the public surface. */
export function _resetOauthSigningKeyCache(): void {
  cached = null
}

function bytesToBase64Url(bytes: Uint8Array): string {
  // We can't reach for Buffer in browser contexts, but this module is
  // server-only, so use it.
  return Buffer.from(bytes).toString('base64url')
}

// Re-export so callers don't need a second import dance.
export { sha256 }
