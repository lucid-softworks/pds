import { describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { verifyPkce } from './pkce'

function mintPair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

describe('verifyPkce', () => {
  it('accepts a matching verifier + challenge pair', () => {
    const { verifier, challenge } = mintPair()
    expect(() =>
      verifyPkce({
        codeVerifier: verifier,
        codeChallenge: challenge,
        method: 'S256',
      }),
    ).not.toThrow()
  })

  it('rejects a mismatched verifier', () => {
    const { challenge } = mintPair()
    const wrongVerifier = randomBytes(32).toString('base64url')
    expect(() =>
      verifyPkce({
        codeVerifier: wrongVerifier,
        codeChallenge: challenge,
        method: 'S256',
      }),
    ).toThrow(/does not match/)
  })

  it('rejects method=plain (atproto OAuth profile)', () => {
    const { verifier, challenge } = mintPair()
    expect(() =>
      verifyPkce({
        codeVerifier: verifier,
        codeChallenge: challenge,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method: 'plain' as any,
      }),
    ).toThrow(/must be S256/)
  })

  it('rejects a verifier that is too short', () => {
    const { challenge } = mintPair()
    expect(() =>
      verifyPkce({
        codeVerifier: 'too-short',
        codeChallenge: challenge,
        method: 'S256',
      }),
    ).toThrow(/not a valid string/)
  })

  it('rejects a verifier with disallowed characters', () => {
    // 43-char string but with a '+' (not in the RFC 7636 allowed set).
    const bad = 'a'.repeat(42) + '+'
    const { challenge } = mintPair()
    expect(() =>
      verifyPkce({
        codeVerifier: bad,
        codeChallenge: challenge,
        method: 'S256',
      }),
    ).toThrow(/not a valid string/)
  })

  it('rejects a challenge that is not base64url', () => {
    const verifier = randomBytes(32).toString('base64url')
    expect(() =>
      verifyPkce({
        codeVerifier: verifier,
        codeChallenge: 'not base64url!@#$',
        method: 'S256',
      }),
    ).toThrow(/not valid base64url/)
  })
})
