// Event sequencer — the write-out side of the firehose.
//
// Every event that `com.atproto.sync.subscribeRepos` will eventually publish
// is first appended to `repo_seq`. This module is the only writer; the
// WebSocket handler (future session) is the only reader.
//
// The on-the-wire payload includes its own assigned `seq`, so we can't fully
// encode the bytes until we know what id Postgres handed us. We therefore
// take a two-step approach for every emit:
//
//   1. INSERT with a placeholder `event` payload; ask Postgres to RETURNING
//      the assigned `seq`.
//   2. Encode the real payload with that `seq` baked in, then UPDATE the
//      row to overwrite `event` with the canonical bytes.
//
// Between (1) and (2) the row exists but its `event` column is a one-byte
// stub. That's fine because the WebSocket handler isn't allowed to read this
// table directly during the brief window — in production these two writes
// would happen inside the same transaction as the repo write, so observers
// only ever see the finished form. See chapter 16 for the outbox-pattern
// discussion.
//
// See chapter 16 — Event sequencer and the firehose.

import { eq, gt, desc, asc } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { db } from '~/lib/db'
// Imported directly because the coordinator wires the barrel re-export at
// merge time. Once it does, this should switch to `from '~/lib/db/schema'`.
import { repoSeq } from '~/lib/db/schema'
import { encode, type CID } from '~/pds/codec'

// `db` is a union of pglite and postgres-js drivers (two `PgDatabase`
// specializations). TypeScript collapses the `.returning(fields)` overload
// across the union to its no-arg form, so we narrow to a shared shape here.
const pg = db as unknown as PgDatabase<PgQueryResultHKT>

export type CommitOp = {
  action: 'create' | 'update' | 'delete'
  path: string
  cid: CID | null
  prev?: CID | null
}

export type CommitEvent = {
  did: string
  commitCid: CID
  rev: string
  prevRev: string | null
  carBytes: Uint8Array
  ops: CommitOp[]
}

export type IdentityEvent = {
  did: string
  handle?: string
}

export type AccountEvent = {
  did: string
  active: boolean
  status?: 'takendown' | 'deactivated' | 'deleted' | 'suspended'
}

// A one-byte placeholder we write at INSERT time and overwrite once we know
// the assigned seq. Never visible to firehose consumers (see header).
const PLACEHOLDER = new Uint8Array([0])

/** Record a `#commit` event and return its assigned seq number. */
export async function emitCommit(event: CommitEvent): Promise<number> {
  const seq = await reserveSeq(event.did, '#commit')
  const payload = {
    seq,
    rebase: false,
    tooBig: false,
    repo: event.did,
    commit: event.commitCid,
    prev: null,
    rev: event.rev,
    since: event.prevRev,
    blocks: event.carBytes,
    ops: event.ops.map((op) => ({
      action: op.action,
      path: op.path,
      cid: op.cid,
      ...(op.prev !== undefined ? { prev: op.prev } : {}),
    })),
    blobs: [] as CID[],
    time: new Date().toISOString(),
  }
  await writeEvent(seq, payload)
  return seq
}

/** Record an `#identity` event and return its assigned seq number. */
export async function emitIdentity(event: IdentityEvent): Promise<number> {
  const seq = await reserveSeq(event.did, '#identity')
  const payload = {
    seq,
    did: event.did,
    time: new Date().toISOString(),
    ...(event.handle !== undefined ? { handle: event.handle } : {}),
  }
  await writeEvent(seq, payload)
  return seq
}

/** Record an `#account` event and return its assigned seq number. */
export async function emitAccount(event: AccountEvent): Promise<number> {
  const seq = await reserveSeq(event.did, '#account')
  const payload = {
    seq,
    did: event.did,
    time: new Date().toISOString(),
    active: event.active,
    ...(event.status !== undefined ? { status: event.status } : {}),
  }
  await writeEvent(seq, payload)
  return seq
}

/** Retrieve events after `cursor` (exclusive), up to `limit` rows (default
 *  500). Used by the WebSocket firehose for historical replay on connect. */
export async function readEventsSince(args: {
  cursor: number
  limit?: number
}): Promise<
  Array<{
    seq: number
    eventType: string
    did: string
    event: Uint8Array
    sequencedAt: Date
  }>
> {
  const limit = args.limit ?? 500
  const rows = await pg
    .select({
      seq: repoSeq.seq,
      eventType: repoSeq.eventType,
      did: repoSeq.did,
      event: repoSeq.event,
      sequencedAt: repoSeq.sequencedAt,
    })
    .from(repoSeq)
    .where(gt(repoSeq.seq, args.cursor))
    .orderBy(asc(repoSeq.seq))
    .limit(limit)
  return rows
}

/** Latest assigned seq on this PDS, or 0 if the log is empty. */
export async function latestSeq(): Promise<number> {
  const row = await pg
    .select({ seq: repoSeq.seq })
    .from(repoSeq)
    .orderBy(desc(repoSeq.seq))
    .limit(1)
  return row[0]?.seq ?? 0
}

/** Mark an event as invalidated. Rare — only used when a previously-emitted
 *  event is retracted. The firehose surfaces these as `#info` frames so
 *  consumers can drop the matching seq from their derived state. */
export async function invalidate(seq: number): Promise<void> {
  await pg
    .update(repoSeq)
    .set({ invalidated: true })
    .where(eq(repoSeq.seq, seq))
}

async function reserveSeq(did: string, eventType: string): Promise<number> {
  const inserted = await pg
    .insert(repoSeq)
    .values({ did, eventType, event: PLACEHOLDER })
    .returning({ seq: repoSeq.seq })
  const seq = inserted[0]?.seq
  if (seq === undefined) {
    throw new Error('sequencer: INSERT returned no seq')
  }
  return seq
}

async function writeEvent(seq: number, payload: unknown): Promise<void> {
  const block = await encode(payload)
  await pg
    .update(repoSeq)
    .set({ event: block.bytes })
    .where(eq(repoSeq.seq, seq))
}
