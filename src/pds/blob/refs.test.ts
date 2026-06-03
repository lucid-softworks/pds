// Behavior contract for the blob-ref walker.
//
// extractBlobCids harvests every `{ $type: 'blob', ref, ... }` leaf reachable
// from a record value. The four shapes the contract pins:
//
//   - Top-level blob ref → found.
//   - Blob ref nested in an array → found.
//   - Multiple distinct blob refs → returned as a deduped Set.
//   - Both JSON ($link string) and CBOR (CID instance) `ref` forms accepted.
//   - The walker treats a blob-ref node as a LEAF — it doesn't recurse into
//     mimeType/size/etc. That matters because real `mimeType: 'image/jpeg'`
//     would never resemble another blob, but a fuzzer could construct one.

import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { encode } from '~/pds/codec'
import { extractBlobCids } from './refs'

const CID_A = 'bafkreieexampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CID_B = 'bafkreieexamplebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('extractBlobCids', () => {
  it('finds a top-level blob ref ($link form)', () => {
    const value = {
      $type: 'app.bsky.actor.profile',
      avatar: {
        $type: 'blob',
        ref: { $link: CID_A },
        mimeType: 'image/jpeg',
        size: 1234,
      },
    }
    const out = extractBlobCids(value)
    expect(out).toBeInstanceOf(Set)
    expect([...out]).toEqual([CID_A])
  })

  it('finds a blob ref nested deep inside arrays', () => {
    const value = {
      $type: 'app.bsky.feed.post',
      text: 'hi',
      embed: {
        $type: 'app.bsky.embed.images',
        images: [
          {
            alt: 'one',
            image: {
              $type: 'blob',
              ref: { $link: CID_A },
              mimeType: 'image/jpeg',
              size: 100,
            },
          },
        ],
      },
    }
    expect([...extractBlobCids(value)]).toEqual([CID_A])
  })

  it('returns multiple distinct refs as a deduped Set', () => {
    const value = {
      images: [
        {
          image: {
            $type: 'blob',
            ref: { $link: CID_A },
            mimeType: 'image/jpeg',
            size: 1,
          },
        },
        {
          image: {
            $type: 'blob',
            ref: { $link: CID_B },
            mimeType: 'image/png',
            size: 2,
          },
        },
        // Dup of A — must not appear twice in the Set.
        {
          image: {
            $type: 'blob',
            ref: { $link: CID_A },
            mimeType: 'image/jpeg',
            size: 1,
          },
        },
      ],
    }
    const out = extractBlobCids(value)
    expect(out.size).toBe(2)
    expect(out.has(CID_A)).toBe(true)
    expect(out.has(CID_B)).toBe(true)
  })

  it('accepts a real CID instance as the ref (CBOR side)', async () => {
    const block = await encode({ test: true })
    const value = {
      $type: 'app.bsky.actor.profile',
      avatar: {
        $type: 'blob',
        ref: block.cid as unknown as CID,
        mimeType: 'image/jpeg',
        size: 50,
      },
    }
    const out = extractBlobCids(value)
    expect(out.size).toBe(1)
    expect([...out][0]).toBe(block.cid.toString())
  })

  it('does NOT recurse into a $type=blob node (leaf treatment)', () => {
    // The "trap" here is a phantom inner blob-ref shape hanging off the outer
    // one's fields. Because the walker treats the outer node as a leaf, the
    // inner CID_B must NOT show up in the result.
    const value = {
      avatar: {
        $type: 'blob',
        ref: { $link: CID_A },
        mimeType: 'image/jpeg',
        size: 99,
        // Garbage that pretends to be another blob ref. If the walker
        // recursed into the leaf's fields, we'd see CID_B in the output.
        bogus: {
          $type: 'blob',
          ref: { $link: CID_B },
          mimeType: 'image/png',
          size: 1,
        },
      },
    }
    const out = extractBlobCids(value)
    expect(out.size).toBe(1)
    expect(out.has(CID_A)).toBe(true)
    expect(out.has(CID_B)).toBe(false)
  })

  it('returns an empty set for a value with no blob refs', () => {
    const value = {
      $type: 'app.bsky.feed.post',
      text: 'just words',
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    expect(extractBlobCids(value).size).toBe(0)
  })

  it('handles null / undefined / primitive inputs without throwing', () => {
    expect(extractBlobCids(null).size).toBe(0)
    expect(extractBlobCids(undefined).size).toBe(0)
    expect(extractBlobCids(42).size).toBe(0)
    expect(extractBlobCids('hello').size).toBe(0)
  })
})
