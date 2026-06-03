// PKCE (RFC 7636) verifier ↔ challenge check.
//
// The OAuth client picks a random `code_verifier` at the start of the flow,
// computes `code_challenge = base64url(sha256(code_verifier))`, and pushes
// the challenge through /oauth/par. At /oauth/token they present the raw
// verifier; we re-derive the challenge and compare. A match proves the same
// client that started the flow is finishing it — even if the authorization
// code leaked en route.
//
// The atproto OAuth profile (and RFC 9700 §2.1.1, the OAuth 2.1 BCP)
// forbids `method = plain` — only S256 is permitted. We enforce that here.
//
// See chapter 21 — OAuth.

import { createHash, timingSafeEqual } from 'node:crypto'

export type PkceArgs = {
  codeVerifier: string
  codeChallenge: string
  method: 'S256'
}

/** Throws if `base64url(sha256(verifier))` doesn't match the challenge, or
 *  if `method` isn't S256. */
export function verifyPkce(args: PkceArgs): void {
  if (args.method !== 'S256') {
    throw new Error(`PKCE method must be S256, got ${String(args.method)}`)
  }
  // RFC 7636 §4.1 — verifier is 43–128 chars of [A-Z a-z 0-9 -._~].
  if (!isValidVerifier(args.codeVerifier)) {
    throw new Error('PKCE code_verifier is not a valid string')
  }
  const derived = createHash('sha256')
    .update(args.codeVerifier, 'ascii')
    .digest()
  const challengeBytes = base64UrlDecode(args.codeChallenge)
  if (challengeBytes === null) {
    throw new Error('PKCE code_challenge is not valid base64url')
  }
  if (
    derived.length !== challengeBytes.length ||
    !timingSafeEqual(derived, challengeBytes)
  ) {
    throw new Error('PKCE code_verifier does not match code_challenge')
  }
}

function isValidVerifier(s: string): boolean {
  if (typeof s !== 'string') return false
  if (s.length < 43 || s.length > 128) return false
  return /^[A-Za-z0-9\-._~]+$/.test(s)
}

function base64UrlDecode(s: string): Buffer | null {
  if (typeof s !== 'string' || s.length === 0) return null
  // S256 challenges are always 43 base64url chars (32-byte SHA-256, no
  // padding); we still accept padded inputs out of caution.
  if (!/^[A-Za-z0-9\-_]+=*$/.test(s)) return null
  try {
    return Buffer.from(s, 'base64url')
  } catch {
    return null
  }
}
