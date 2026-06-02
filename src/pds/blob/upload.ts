// Blob upload pipeline.
//
// Three steps: hash → store → record. The CID is computed before any I/O so
// re-uploads of the same bytes by the same account are idempotent — the
// metadata row's primary key is the CID itself.
//
// See chapter 15 — Blobs.

import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'
import { db } from '~/lib/db'
import { blobs } from '~/lib/db/schema'
import { getBlobStore } from './store'

// AT Protocol assigns blobs the `raw` multicodec (0x55) because their bytes
// aren't structured — there's no DAG to decode. The codec module only knows
// dag-cbor (0x71), so for blobs we hash inline rather than threading a second
// codec through the rest of the code.
const RAW_CODEC = 0x55

/** Compute the raw-codec CIDv1 for a blob's bytes. */
async function cidForRawBytes(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes)
  return CID.createV1(RAW_CODEC, hash)
}

export type BlobRef = {
  $type: 'blob'
  ref: CID
  mimeType: string
  size: number
}

/** Hash bytes, write them to the store, persist the metadata row. */
export async function uploadBlob(args: {
  creator: string
  bytes: Uint8Array
  mimeType: string
}): Promise<BlobRef> {
  const cid = await cidForRawBytes(args.bytes)
  const cidStr = cid.toString()
  const storeKey = await getBlobStore().put({
    cid,
    bytes: args.bytes,
    creator: args.creator,
    mimeType: args.mimeType,
  })
  // Upsert by CID. Repeated uploads of the same bytes by the same account are
  // a no-op at the metadata layer; the store has already overwritten the file
  // with identical contents.
  await db
    .insert(blobs)
    .values({
      cid: cidStr,
      creator: args.creator,
      mimeType: args.mimeType,
      size: args.bytes.length,
      storeKey,
    })
    .onConflictDoNothing()
  return {
    $type: 'blob',
    ref: cid,
    mimeType: args.mimeType,
    size: args.bytes.length,
  }
}
