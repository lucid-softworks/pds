// Walk a record value and harvest its blob refs.
//
// A blob ref is the leaf shape `{ $type: 'blob', ref, mimeType, size }`. The
// `ref` field is either a CID instance (when the value came out of DAG-CBOR
// decode) or a JSON-side envelope `{ $link: '<cid-string>' }` (when the value
// came in via XRPC JSON). Records may carry zero, one, or many refs at any
// depth — directly on the root, inside nested objects, inside arrays, inside
// union members. The walk is recursive and treats a blob ref as a leaf: we
// don't recurse into its own fields.
//
// See chapter 15 — Blobs.

import { CID } from '~/pds/codec'

export type BlobRef = {
  cid: string
  mimeType?: string
  size?: number
}

/** Collect every blob-ref CID reachable from `value`. */
export function extractBlobCids(value: unknown): Set<string> {
  const out = new Set<string>()
  walk(value, (ref) => out.add(ref.cid))
  return out
}

/** Same walk, but keeps mimeType/size in case the caller needs them. Dedup is
 *  by CID — later occurrences of the same CID win on metadata. */
export function extractBlobRefs(value: unknown): BlobRef[] {
  const byCid = new Map<string, BlobRef>()
  walk(value, (ref) => byCid.set(ref.cid, ref))
  return [...byCid.values()]
}

function walk(value: unknown, emit: (ref: BlobRef) => void): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const v of value) walk(v, emit)
    return
  }
  if (typeof value !== 'object') return

  const obj = value as Record<string, unknown>
  if (obj['$type'] === 'blob' && obj['ref'] !== undefined) {
    const cid = refToCidString(obj['ref'])
    if (cid) {
      const mimeType = typeof obj['mimeType'] === 'string' ? obj['mimeType'] : undefined
      const size = typeof obj['size'] === 'number' ? obj['size'] : undefined
      emit({ cid, mimeType, size })
    }
    // A blob ref is a leaf — don't recurse into mimeType/size/etc.
    return
  }

  for (const key in obj) walk(obj[key], emit)
}

function refToCidString(ref: unknown): string | null {
  // CBOR side: ref is a CID instance. CID.asCID handles both real instances
  // and structurally-compatible duck-types from cross-realm decodes.
  const asCid = CID.asCID(ref)
  if (asCid) return asCid.toString()
  // JSON side: `{ $link: '<cid>' }`.
  if (ref && typeof ref === 'object') {
    const link = (ref as { $link?: unknown }).$link
    if (typeof link === 'string' && link.length > 0) return link
  }
  return null
}

/** Tiny round-trip self-check, exported for the chapter's "Try it" section.
 *  Not exercised in the request path. */
export function runBlobAttachmentSelfTest(): { ok: true } {
  const sample = {
    $type: 'app.bsky.feed.post',
    text: 'hi',
    embed: {
      $type: 'app.bsky.embed.images',
      images: [
        {
          alt: 'a cat',
          image: {
            $type: 'blob',
            ref: { $link: 'bafkreieexampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
            mimeType: 'image/jpeg',
            size: 100,
          },
        },
        {
          alt: 'another',
          image: {
            $type: 'blob',
            ref: { $link: 'bafkreieexamplebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
            mimeType: 'image/png',
            size: 200,
          },
        },
      ],
    },
  }
  const cids = extractBlobCids(sample)
  if (cids.size !== 2) throw new Error(`expected 2 cids, got ${cids.size}`)
  // Idempotence: re-walk same value, same set.
  const again = extractBlobCids(sample)
  if (again.size !== 2) throw new Error('walk is not idempotent')
  return { ok: true }
}
