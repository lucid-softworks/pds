// Behavior contract for TID generation.
//
// TIDs are 13-character base32-ish strings that sort lexicographically by
// time. Two guarantees the MST and the records index lean on:
//   - alphabet + length are fixed
//   - successive calls are strictly increasing (within a process)
// These tests pin both.

import { describe, expect, it } from 'vitest'
import { isValidTid, nextTid, tidToMicros } from './tid'

const ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'

describe('nextTid()', () => {
  it('produces a 13-character string', () => {
    const tid = nextTid()
    expect(tid).toHaveLength(13)
  })

  it('uses only characters from the s32 alphabet', () => {
    for (let i = 0; i < 25; i++) {
      const tid = nextTid()
      for (const ch of tid) {
        expect(ALPHABET).toContain(ch)
      }
    }
  })

  it('is strictly increasing across successive calls', () => {
    // 200 calls in a tight loop hammers the "same microsecond" branch where
    // the generator has to step forward manually instead of trusting Date.now.
    let prev = nextTid()
    for (let i = 0; i < 200; i++) {
      const next = nextTid()
      expect(next > prev).toBe(true)
      prev = next
    }
  })
})

describe('isValidTid()', () => {
  it('accepts a freshly-generated TID', () => {
    expect(isValidTid(nextTid())).toBe(true)
  })

  it('rejects strings of the wrong length', () => {
    expect(isValidTid('')).toBe(false)
    expect(isValidTid('a')).toBe(false)
    expect(isValidTid('a'.repeat(12))).toBe(false)
    expect(isValidTid('a'.repeat(14))).toBe(false)
  })

  it('rejects characters outside the s32 alphabet', () => {
    // Uppercase, '0', '1', '8', '9' are all out of alphabet.
    expect(isValidTid('A'.repeat(13))).toBe(false)
    expect(isValidTid('0'.repeat(13))).toBe(false)
    expect(isValidTid('1'.repeat(13))).toBe(false)
    expect(isValidTid('aaaaaaaaaaaa8')).toBe(false)
    expect(isValidTid('aaaaaaaaaaaa!')).toBe(false)
  })

  it('accepts every character of the alphabet at every position', () => {
    // 13-character all-min and all-max must both be syntactically valid.
    expect(isValidTid(ALPHABET[0]!.repeat(13))).toBe(true)
    expect(isValidTid(ALPHABET[ALPHABET.length - 1]!.repeat(13))).toBe(true)
  })
})

describe('tidToMicros()', () => {
  it('returns a microsecond value close to "now"', () => {
    const nowMicros = BigInt(Date.now()) * 1000n
    const tid = nextTid()
    const us = tidToMicros(tid)
    // Allow a 5-second wobble in either direction.
    const drift = us > nowMicros ? us - nowMicros : nowMicros - us
    expect(drift < 5_000_000n).toBe(true)
  })

  it('preserves order across the round-trip', () => {
    const a = nextTid()
    const b = nextTid()
    expect(tidToMicros(a) <= tidToMicros(b)).toBe(true)
  })
})
