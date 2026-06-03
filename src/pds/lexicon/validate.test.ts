// Behavior contract for the lexicon validator.
//
// We use the real bundled lexicon catalog so these tests double as
// regression coverage on the lexicon files themselves. The post schema
// pins:
//   - required-field enforcement (text missing → reject)
//   - grapheme-aware maxGraphemes (a ZWJ family emoji counts as 1)
//   - 301-grapheme text exceeds maxGraphemes (= 300)
// And the cid-link tests pin the dual JSON/CBOR shape every $link path
// has to accept.

import { beforeAll, describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { encode } from '~/pds/codec'
import {
  ValidationError,
  loadBundledLexicons,
  makeCatalog,
  compileSchema,
  validateAgainstNsid,
} from './index'
import type { LexiconCatalog } from './loader'
import type { LexiconDoc } from './types'

let catalog: LexiconCatalog
beforeAll(async () => {
  catalog = await loadBundledLexicons()
})

describe('app.bsky.feed.post', () => {
  const validPost = () => ({
    $type: 'app.bsky.feed.post',
    text: 'hello world',
    createdAt: '2024-01-01T00:00:00.000Z',
  })

  it('accepts a minimal valid post', () => {
    expect(() => validateAgainstNsid(catalog, 'app.bsky.feed.post', validPost())).not.toThrow()
  })

  it('rejects a post missing the required text field', () => {
    const post = validPost() as Record<string, unknown>
    delete post.text
    expect(() =>
      validateAgainstNsid(catalog, 'app.bsky.feed.post', post),
    ).toThrow(ValidationError)
  })

  it('rejects a post whose text exceeds maxGraphemes (300)', () => {
    const post = {
      ...validPost(),
      text: 'a'.repeat(301), // 301 ASCII graphemes
    }
    expect(() =>
      validateAgainstNsid(catalog, 'app.bsky.feed.post', post),
    ).toThrow(/maxGraphemes/)
  })

  it('counts a 7-codepoint ZWJ family emoji as 1 grapheme', () => {
    // U+1F468 U+200D U+1F469 U+200D U+1F467 U+200D U+1F466 — "family: man,
    // woman, girl, boy". `Intl.Segmenter` segments this to a single
    // grapheme cluster. The naive code-point count would be 7. We can't
    // use the post lexicon to exhibit this directly (a single family emoji
    // is 25 UTF-8 bytes, so 300 of them would blow the byte-length cap of
    // 3000), so we build a tiny ad-hoc schema and assert the byte cap is
    // satisfied while the grapheme cap rejects only 2 clusters at limit 1.
    const family = '👨‍👩‍👧‍👦'
    expect([...family].length).toBeGreaterThan(1) // sanity: codepoints != graphemes

    const validator = compileSchema(
      { type: 'string', maxGraphemes: 1 },
      catalog,
      'test.fake.nsid',
    )
    // 1 family emoji = 1 grapheme cluster → accepted at maxGraphemes=1.
    expect(() => validator(family)).not.toThrow()
    // 2 family emojis = 2 grapheme clusters → rejected.
    expect(() => validator(family + family)).toThrow(/maxGraphemes/)
  })
})

describe('cid-link', () => {
  // Build a tiny catalog with a single object that holds one cid-link.
  function refCatalog(): LexiconCatalog {
    const doc: LexiconDoc = {
      lexicon: 1,
      id: 'test.cid.link',
      defs: {
        main: {
          type: 'object',
          required: ['ref'],
          properties: { ref: { type: 'cid-link' } },
        },
      },
    } as unknown as LexiconDoc
    return makeCatalog(new Map([[doc.id, doc]]))
  }

  it("accepts the JSON shape: { $link: 'bafy...' }", async () => {
    const cat = refCatalog()
    const some = await encode({ x: 1 })
    const value = { ref: { $link: some.cid.toString() } }
    expect(() =>
      validateAgainstNsid(cat, 'test.cid.link', value),
    ).not.toThrow()
  })

  it('accepts a raw CID instance (CBOR path)', async () => {
    const cat = refCatalog()
    const some = await encode({ x: 1 })
    const value = { ref: some.cid as unknown as CID }
    expect(() =>
      validateAgainstNsid(cat, 'test.cid.link', value),
    ).not.toThrow()
  })

  it("rejects an obviously-bad $link string", () => {
    const cat = refCatalog()
    const value = { ref: { $link: 'not-a-cid' } }
    expect(() =>
      validateAgainstNsid(cat, 'test.cid.link', value),
    ).toThrow(/cid-link/)
  })
})

describe('compileSchema sanity', () => {
  it('rejects a non-object root for an object schema', () => {
    const validator = compileSchema(
      {
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'string' } },
      },
      catalog,
      'test.fake.nsid',
    )
    expect(() => validator('not an object')).toThrow(ValidationError)
    expect(() => validator(['arr'])).toThrow(ValidationError)
  })
})
