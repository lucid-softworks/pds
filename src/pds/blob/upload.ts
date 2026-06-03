// Blob upload pipeline.
//
// Three steps: hash → store → record. The CID is computed before any I/O so
// re-uploads of the same bytes by the same account are idempotent — the
// metadata row's primary key is the CID itself.
//
// See chapter 15 — Blobs.

import { eq } from 'drizzle-orm'
import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'
import { db } from '~/lib/db'
import { blobs } from '~/lib/db/schema'
import { blobUploadBytesTotal, blobsTotal } from '~/lib/metrics'
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

/** Hash bytes, write them to the store, persist the metadata row.
 *
 *  Note: we do not check that the uploaded CID matches any existing record
 *  reference — the client uploads bytes *first* and constructs the record
 *  that names them seconds later. Attachment happens in `applyWrites` via
 *  `extractBlobCids`; until then the blob sits unreferenced and the GC sweep
 *  (`src/pds/blob/gc.ts`) leaves it alone until the grace window expires. */
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
  //
  // We probe for the pre-existing row first so we can tell "fresh insert"
  // from "dedup hit" for metrics. Drizzle's `.returning()` overload doesn't
  // narrow cleanly across the pglite|postgres-js union (same issue noted in
  // sequence.ts) so a SELECT is the portable shape.
  const existing = await db
    .select({ cid: blobs.cid })
    .from(blobs)
    .where(eq(blobs.cid, cidStr))
    .limit(1)
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
  // Always credit the bytes-uploaded counter (the operator wants to see
  // load even when the upload was a dedup hit). Only increment the row
  // counter on a fresh insert.
  blobUploadBytesTotal.inc(undefined, args.bytes.length)
  if (existing.length === 0) blobsTotal.inc()
  return {
    $type: 'blob',
    ref: cid,
    mimeType: args.mimeType,
    size: args.bytes.length,
  }
}
