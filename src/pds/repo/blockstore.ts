// Block storage over Postgres `repo_blocks`.
//
// Every encoded MST node and every signed commit lands here, addressed by
// (repo_did, cid). The reads/writes are deliberately simple: no caching, no
// batching beyond what postgres-js / pglite already do. We'll add per-request
// caching in a later chapter once the firehose makes hot blocks visible.

import { eq, and, inArray } from 'drizzle-orm'
import { db } from '~/lib/db'
import { repoBlocks } from '~/lib/db/schema'
import { CID, parseCid } from '~/pds/codec'
import type { Block } from '~/pds/codec'

export type StoredBlock = Block

// Minimal subset of Drizzle's db / tx surface that putBlocks + putBlock use,
// so callers in a `db.transaction(tx => …)` can thread `tx` through instead
// of writing outside the open transaction. Doing the latter deadlocks on
// single-connection drivers like PGlite (the tx holds the write lock while
// the outside-tx write waits on it forever).
type WriteSurface = {
  insert: typeof db.insert
}

/** Store a single block for a repo, idempotently. Pass `tx` when called from
 *  inside a `db.transaction` callback. `repoRev` (optional) tags the block
 *  with the commit rev at which it was first written; the
 *  `com.atproto.sync.getRepo?since=<rev>` filter reads this column. */
export async function putBlock(
  repoDid: string,
  block: Block,
  handle: WriteSurface = db,
  repoRev?: string,
): Promise<void> {
  await handle
    .insert(repoBlocks)
    .values({
      repoDid,
      cid: block.cid.toString(),
      bytes: block.bytes,
      size: block.bytes.length,
      repoRev: repoRev ?? null,
    })
    .onConflictDoNothing()
}

/** Store multiple blocks for a repo, idempotently. Pass `tx` when called from
 *  inside a `db.transaction` callback (see `putBlock` above). */
export async function putBlocks(
  repoDid: string,
  blocks: Block[],
  handle: WriteSurface = db,
  repoRev?: string,
): Promise<void> {
  if (blocks.length === 0) return
  await handle
    .insert(repoBlocks)
    .values(
      blocks.map((b) => ({
        repoDid,
        cid: b.cid.toString(),
        bytes: b.bytes,
        size: b.bytes.length,
        repoRev: repoRev ?? null,
      })),
    )
    .onConflictDoNothing()
}

/** Fetch one block by CID, scoped to a repo. */
export async function getBlock(
  repoDid: string,
  cid: CID,
): Promise<StoredBlock | null> {
  const rows = await db
    .select()
    .from(repoBlocks)
    .where(and(eq(repoBlocks.repoDid, repoDid), eq(repoBlocks.cid, cid.toString())))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return { cid: parseCid(row.cid), bytes: toUint8Array(row.bytes) }
}

/** Fetch many blocks at once. Returns them in the same order as the input
 *  CIDs; missing blocks are omitted (callers should check). */
export async function getBlocks(
  repoDid: string,
  cids: CID[],
): Promise<StoredBlock[]> {
  if (cids.length === 0) return []
  const stringCids = cids.map((c) => c.toString())
  const rows = await db
    .select()
    .from(repoBlocks)
    .where(
      and(eq(repoBlocks.repoDid, repoDid), inArray(repoBlocks.cid, stringCids)),
    )
  const byCid = new Map<string, StoredBlock>()
  for (const row of rows) {
    byCid.set(row.cid, {
      cid: parseCid(row.cid),
      bytes: toUint8Array(row.bytes),
    })
  }
  return stringCids
    .map((s) => byCid.get(s))
    .filter((b): b is StoredBlock => b !== undefined)
}

// Postgres `bytea` deserialization differs between drivers: postgres-js gives
// us a Buffer, PGlite gives us a Uint8Array. Always return a plain Uint8Array
// view of the same memory so downstream code only sees one type.
function toUint8Array(b: Uint8Array): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}
