// XRPC handler: com.atproto.sync.getBlob
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getBlob.json
//
// Public, unauthenticated. The client asks for (did, cid) and we stream the
// bytes back with the stored Content-Type. A careful client will hash the
// bytes as they arrive and refuse the response if it doesn't match the
// requested CID — see chapter 15.

import { and, eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { blobs } from '~/lib/db/schema'
import { getBlobStore } from '~/pds/blob/store'

const handler: Handler = async ({ params }) => {
  const did = params.did
  const cid = params.cid
  if (!did) throw BadRequest('missing did query parameter')
  if (!cid) throw BadRequest('missing cid query parameter')

  const rows = await db
    .select({
      mimeType: blobs.mimeType,
      size: blobs.size,
      storeKey: blobs.storeKey,
      takedownRef: blobs.takedownRef,
    })
    .from(blobs)
    .where(and(eq(blobs.cid, cid), eq(blobs.creator, did)))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound('blob not found', 'BlobNotFound')
  // Takedown enforcement (chapter 24): the bytes stay on disk so a
  // reverseTakedown can restore them, but we stop serving while the
  // ref is non-null. BlobNotFound matches the deletion shape — the
  // moderation decision is opaque to the caller.
  if (row.takedownRef !== null) {
    throw NotFound('blob not found', 'BlobNotFound')
  }

  const store = getBlobStore()
  const stream = await store.getStream(row.storeKey)
  if (!stream) {
    // Metadata row exists but bytes don't — store/db drift. Surface as
    // BlobNotFound rather than 500; the operator can reconcile.
    throw NotFound('blob bytes missing from store', 'BlobNotFound')
  }
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': row.mimeType,
      'content-length': String(row.size),
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getBlob'
