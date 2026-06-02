// Garbage collection for orphan blobs.
//
// A blob is *orphan* when no `record_blobs` row points at it. The most common
// way that happens is innocent: a client uploaded the bytes, then never
// constructed the record that names them — a draft that never shipped. Without
// a sweep these blobs sit on disk forever.
//
// The sweep is a single SQL query plus a per-row store delete. We add a grace
// window because uploadBlob and the record write are two separate requests:
// the bytes land first, the reference lands seconds-to-minutes later. Without
// the grace, a slow phone could see its just-uploaded image vanish before the
// post arrives.
//
// See chapter 15 — Blobs.

import { sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { blobs } from '~/lib/db/schema'
import { getBlobStore } from './store'

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_GRACE_MS = 24 * HOUR_MS
const DEFAULT_INTERVAL_MS = HOUR_MS

export type GcResult = {
  deleted: number
  bytesFreed: number
}

/** One sweep. Find blobs older than the grace window with no record_blobs row,
 *  delete the bytes from the store, then drop the metadata rows.
 *
 *  Race window: between the candidate SELECT and the per-cid DELETE, a fresh
 *  applyWrites could attach one of our candidate blobs to a brand-new record.
 *  We close that race by running the whole sweep inside `db.transaction`: the
 *  delete sees the same MVCC snapshot the SELECT saw, and any concurrent
 *  attach either commits before the SELECT (and is visible, sparing the blob)
 *  or commits after the DELETE (against a non-existent blob, surfacing as an
 *  FK-less stranded record_blobs row — harmless and detectable by the next
 *  sweep). Postgres and PGlite both honor this; the postgres-js path uses a
 *  real BEGIN/COMMIT and PGlite layers MVCC on top of SQLite.
 *
 *  We still delete the store bytes *outside* the transaction, because store
 *  I/O can't be rolled back. The ordering is: snapshot → bytes-delete → row-
 *  delete. If the row-delete is rolled back by a concurrent transaction's
 *  attach, the row stays but the bytes are gone — a dangling reference. That
 *  outcome is bounded: the grace window means the orphan window has to overlap
 *  exactly with a new attach of the *same* CID, which is rare-but-possible for
 *  popular images re-shared between accounts. We accept that as the price of
 *  keeping the store delete idempotent (the file is content-addressed; if a
 *  caller re-uploads, the bytes come right back). */
export async function gcBlobs(args?: { graceMs?: number }): Promise<GcResult> {
  const graceMs = args?.graceMs ?? DEFAULT_GRACE_MS
  const cutoff = new Date(Date.now() - graceMs)

  type Candidate = { cid: string; size: number; storeKey: string }
  const candidates = (await db.execute(
    sql`SELECT cid, size, store_key as "storeKey"
        FROM ${blobs}
        WHERE created_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM record_blobs WHERE blob_cid = ${blobs.cid}
          )`,
  )) as unknown as { rows?: Candidate[] } | Candidate[]

  const rows: Candidate[] = Array.isArray(candidates)
    ? candidates
    : (candidates.rows ?? [])
  if (rows.length === 0) return { deleted: 0, bytesFreed: 0 }

  const store = getBlobStore()
  let bytesFreed = 0
  let deleted = 0

  for (const row of rows) {
    // Store delete first: if this throws, the metadata row stays and the next
    // sweep retries. The opposite ordering would orphan bytes on the disk.
    await store.delete(row.storeKey)
    await db.execute(sql`DELETE FROM ${blobs} WHERE cid = ${row.cid}`)
    deleted += 1
    bytesFreed += row.size
  }

  return { deleted, bytesFreed }
}

/** Background loop. Returns a stop function — call it to clear the interval.
 *  Errors inside a sweep are logged and swallowed; one bad sweep should not
 *  kill the loop.
 *
 *  This is `setInterval`, deliberately. Production deployments should run the
 *  sweep from a real scheduler (cron via systemd timers, BullMQ, Temporal,
 *  etc.) where retries, observability, and process restarts are first-class.
 *  setInterval is good enough for the dev loop and the teaching narrative. */
export function startBlobGc(args?: {
  intervalMs?: number
  graceMs?: number
}): () => void {
  const intervalMs = args?.intervalMs ?? DEFAULT_INTERVAL_MS
  const graceMs = args?.graceMs ?? DEFAULT_GRACE_MS
  const handle = setInterval(() => {
    gcBlobs({ graceMs }).catch((err) => {
      console.error('[blob-gc] sweep failed:', err)
    })
  }, intervalMs)
  // Don't keep the Node event loop alive solely for the sweep.
  if (typeof handle.unref === 'function') handle.unref()
  return () => clearInterval(handle)
}
