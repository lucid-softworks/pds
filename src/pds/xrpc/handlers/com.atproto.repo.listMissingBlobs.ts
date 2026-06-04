// XRPC handler: com.atproto.repo.listMissingBlobs
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/listMissingBlobs.json
//
// Destination-side. After importRepo lands, the user's records reference
// blob CIDs the destination PDS doesn't yet have bytes for. This endpoint
// is the worklist: every CID that appears in `record_blobs` for the caller
// but has no matching `blobs` row.
//
// The migrating user iterates this list, fetches each CID from their old
// PDS via `com.atproto.sync.getBlob`, and POSTs it through `uploadBlob`
// here. Pagination matters — a heavy account can have thousands of blobs.
//
// Note: until 2024 a transitional `com.atproto.sync.listMissingBlobs`
// NSID was floating around in early drafts; the canonical lexicon (the
// one bsky.app and goat use) is the `repo.*` form, which is what we
// register here.
//
// See chapter 20 — Migration.

import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { blobs, recordBlobs } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 500

const handler: Handler = async ({ params, authorization }) => {
  const me = await requireAccessAuth(authorization)

  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const parsed = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw BadRequest(
        `limit must be between 1 and ${MAX_LIMIT}`,
        'InvalidRequest',
      )
    }
    limit = parsed
  }
  const cursor = params.cursor?.trim()

  // LEFT JOIN record_blobs → blobs on cid; rows where blobs.cid IS NULL are
  // the missing ones. Cursor is the last (blob_cid, record_uri) pair from
  // the previous page; we only paginate by blob_cid for simplicity (a tiny
  // amount of duplication if the same blob is referenced by many records is
  // acceptable — the client uploads once and re-runs the query).
  const rows = await db
    .select({
      blobCid: recordBlobs.blobCid,
      recordUri: recordBlobs.recordUri,
    })
    .from(recordBlobs)
    .leftJoin(blobs, eq(blobs.cid, recordBlobs.blobCid))
    .where(
      and(
        eq(recordBlobs.repoDid, me.did),
        isNull(blobs.cid),
        cursor ? gt(recordBlobs.blobCid, cursor) : undefined,
      ),
    )
    .orderBy(asc(recordBlobs.blobCid))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.blobCid
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    blobs: page.map((r) => ({
      cid: r.blobCid,
      recordUri: r.recordUri,
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.repo.listMissingBlobs'
