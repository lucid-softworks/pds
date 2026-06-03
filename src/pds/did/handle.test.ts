// Behavior contract for handle syntax validation.
//
// Anything that ends up in `accounts.handle` or as an `alsoKnownAs` entry
// flows through these checks. Mistakes here cascade into resolver bugs and
// DID-document corruption, so we pin the reject cases explicitly.

import { describe, expect, it } from 'vitest'
import { isReservedTld, isValidHandleSyntax } from './handle'

describe('isValidHandleSyntax — accepts', () => {
  it.each([
    ['alice.bsky.social'],
    ['alice.test'],
    ['a-b-c.example.com'],
    ['x.y'],
    ['nested.label.example.org'],
    ['xn--nxasmq6b.example'],
  ])('accepts %s', (handle) => {
    expect(isValidHandleSyntax(handle)).toBe(true)
  })
})

describe('isValidHandleSyntax — rejects', () => {
  it('rejects too-short handles', () => {
    expect(isValidHandleSyntax('a')).toBe(false)
    expect(isValidHandleSyntax('ab')).toBe(false)
  })

  it('rejects single-label handles (no dot)', () => {
    expect(isValidHandleSyntax('alice')).toBe(false)
  })

  it('rejects uppercase letters', () => {
    expect(isValidHandleSyntax('Alice.bsky.social')).toBe(false)
    expect(isValidHandleSyntax('alice.Bsky.social')).toBe(false)
  })

  it('rejects labels with a leading hyphen', () => {
    expect(isValidHandleSyntax('-alice.bsky.social')).toBe(false)
    expect(isValidHandleSyntax('alice.-bsky.social')).toBe(false)
  })

  it('rejects labels with a trailing hyphen', () => {
    expect(isValidHandleSyntax('alice-.bsky.social')).toBe(false)
  })

  it('rejects a numeric-only TLD', () => {
    expect(isValidHandleSyntax('alice.123')).toBe(false)
  })

  it('rejects handles with empty labels (consecutive dots)', () => {
    expect(isValidHandleSyntax('alice..social')).toBe(false)
    expect(isValidHandleSyntax('.alice.social')).toBe(false)
    expect(isValidHandleSyntax('alice.social.')).toBe(false)
  })
})

describe('isReservedTld', () => {
  it.each([
    ['alice.local'],
    ['alice.arpa'],
    ['alice.invalid'],
    ['alice.localhost'],
    ['alice.internal'],
    ['alice.example'],
    ['alice.alt'],
    ['alice.onion'],
  ])('returns true for reserved TLD: %s', (handle) => {
    expect(isReservedTld(handle)).toBe(true)
  })

  it('returns false for handles on common public TLDs', () => {
    expect(isReservedTld('alice.com')).toBe(false)
    expect(isReservedTld('alice.bsky.social')).toBe(false)
    expect(isReservedTld('alice.dev')).toBe(false)
  })

  // Policy decision: `.test` is intentionally NOT in the reserved TLD set.
  // The dev port uses `.test` handles routinely (e.g. `alice.test`) so the
  // local toolchain has a TLD it can hand out without spec-IANA collisions.
  // RFC 6761 reserves `.test` for testing/development specifically, which
  // is exactly what we use it for here — so allowing it in this PDS is
  // consistent with the IETF intent even if a strict reading of "reserved"
  // would say otherwise. See also src/pds/account/create.ts.
  it('does NOT reserve the .test TLD (allowed in dev)', () => {
    expect(isReservedTld('alice.test')).toBe(false)
  })
})
