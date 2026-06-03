import { describe, expect, it } from 'vitest'
import {
  byteLength,
  graphemeLength,
  POST_MAX_BYTES,
  POST_MAX_GRAPHEMES,
  validatePostText,
} from './postLimits'

describe('byteLength', () => {
  it('counts ASCII bytes', () => {
    expect(byteLength('hello')).toBe(5)
  })

  it('counts multi-byte UTF-8 sequences', () => {
    // 'é' is two bytes in UTF-8 (C3 A9).
    expect(byteLength('é')).toBe(2)
    // A non-BMP emoji is four bytes in UTF-8.
    expect(byteLength('😀')).toBe(4)
  })
})

describe('graphemeLength', () => {
  it('counts ASCII as one per character', () => {
    expect(graphemeLength('hello')).toBe(5)
  })

  it('treats a non-BMP emoji as one grapheme (not two code units)', () => {
    expect(graphemeLength('😀')).toBe(1)
  })

  it('treats a regional-indicator flag as one grapheme', () => {
    // 🇯🇵 is two code points (U+1F1EF + U+1F1F5) but one user-perceived char.
    // Without Intl.Segmenter the fallback returns 2 — both are acceptable
    // because the lexicon validator's fallback does the same. We only
    // assert that *with* Segmenter (which Node 22+ ships) we get 1.
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      expect(graphemeLength('🇯🇵')).toBe(1)
    }
  })
})

describe('validatePostText', () => {
  it('rejects empty text', () => {
    const v = validatePostText('')
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/empty/i)
  })

  it('rejects whitespace-only text', () => {
    const v = validatePostText('   \n\t')
    expect(v.ok).toBe(false)
  })

  it('accepts a normal post', () => {
    const v = validatePostText('hello world')
    expect(v.ok).toBe(true)
    expect(v.bytes).toBe(11)
    expect(v.graphemes).toBe(11)
    expect(v.reason).toBeNull()
  })

  it('rejects when over the byte cap', () => {
    const v = validatePostText('a'.repeat(POST_MAX_BYTES + 1))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/bytes/)
  })

  it('rejects when over the grapheme cap', () => {
    // Use a 2-byte char so we hit graphemes before bytes — 'é' is 2 bytes.
    // 301 of those = 602 bytes, well under 3000.
    const v = validatePostText('é'.repeat(POST_MAX_GRAPHEMES + 1))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/characters/)
  })
})
