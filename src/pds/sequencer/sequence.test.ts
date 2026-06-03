// Behavior contract for the event sequencer.
//
// The sequencer is the firehose's write side: every event that
// subscribeRepos will eventually publish first lands here. The contract this
// file pins:
//
//   - emitCommit / emitTombstone produce strictly-increasing seqs.
//   - readEventsSince honors its cursor (exclusive) and limit.
//   - invalidate(seq) sets the row's flag without touching the payload.
//   - The persisted `event` bytea decodes back to a DAG-CBOR object whose
//     own `seq` field equals the row's seq — i.e. the two-step assign-then-
//     encode trick (described in sequence.ts's header) actually round-trips.

import { setupTestDbEnv, migrateProcessDb } from '../../../tests/db'

// IMPORTANT: must run before any import that touches `~/lib/db`.
setupTestDbEnv()

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { repoSeq } from '~/lib/db/schema'
import { decode, encode } from '~/pds/codec'
import {
  emitCommit,
  emitTombstone,
  invalidate,
  latestSeq,
  readEventsSince,
} from './sequence'

beforeAll(async () => {
  await migrateProcessDb()
})

const TEST_DID = 'did:plc:seqtestaaaaaaaaaaaaaaaaa'

// A small valid commit event payload. The CID + carBytes don't have to be
// "real" in the sense of pointing at a persisted block — the sequencer just
// stores whatever's handed to it.
async function makeCommitEvent(suffix: string) {
  const block = await encode({ test: 'commit-payload', suffix })
  return {
    did: TEST_DID,
    commitCid: block.cid,
    rev: '3jzfcijpj2z2a',
    prevRev: null,
    carBytes: block.bytes,
    ops: [
      {
        action: 'create' as const,
        path: 'app.bsky.feed.post/' + suffix,
        cid: block.cid,
      },
    ],
  }
}

describe('emitCommit', () => {
  it('returns a positive seq number', async () => {
    const evt = await makeCommitEvent('a')
    const seq = await emitCommit(evt)
    expect(seq).toBeGreaterThan(0)
  })

  it('three sequential emits yield strictly-increasing seqs', async () => {
    const s1 = await emitCommit(await makeCommitEvent('b1'))
    const s2 = await emitCommit(await makeCommitEvent('b2'))
    const s3 = await emitCommit(await makeCommitEvent('b3'))
    expect(s2).toBeGreaterThan(s1)
    expect(s3).toBeGreaterThan(s2)
  })
})

describe('readEventsSince', () => {
  it('cursor=0 returns events in ascending seq order', async () => {
    const all = await readEventsSince({ cursor: 0 })
    expect(all.length).toBeGreaterThanOrEqual(1)
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq)
    }
  })

  it('cursor=latestSeq returns no rows', async () => {
    const top = await latestSeq()
    const rows = await readEventsSince({ cursor: top })
    expect(rows).toEqual([])
  })

  it('cursor=0, limit=1 returns exactly one row', async () => {
    const rows = await readEventsSince({ cursor: 0, limit: 1 })
    expect(rows).toHaveLength(1)
  })
})

describe('invalidate', () => {
  it('flips the invalidated flag without touching the payload', async () => {
    const seq = await emitCommit(await makeCommitEvent('inv'))
    const beforeRows = await db
      .select()
      .from(repoSeq)
      .where(eq(repoSeq.seq, seq))
    expect(beforeRows[0]!.invalidated).toBe(false)
    const eventBefore = beforeRows[0]!.event

    await invalidate(seq)

    const afterRows = await db
      .select()
      .from(repoSeq)
      .where(eq(repoSeq.seq, seq))
    expect(afterRows[0]!.invalidated).toBe(true)
    // The event payload should be untouched.
    expect(afterRows[0]!.event).toEqual(eventBefore)
  })
})

describe('persisted event payload', () => {
  it('decodes back to a DAG-CBOR object whose seq matches the row seq', async () => {
    const seq = await emitCommit(await makeCommitEvent('roundtrip'))
    const rows = await db
      .select()
      .from(repoSeq)
      .where(eq(repoSeq.seq, seq))
    const row = rows[0]!
    // Event bytes come back as a Buffer/Uint8Array; decode requires a
    // Uint8Array. drizzle-orm's pglite driver already returns Uint8Array.
    const eventBytes =
      row.event instanceof Uint8Array
        ? row.event
        : new Uint8Array(row.event as ArrayBufferLike)
    const decoded = (await decode(eventBytes)) as { seq?: unknown }
    expect(typeof decoded.seq).toBe('number')
    expect(decoded.seq).toBe(seq)
  })
})

describe('emitTombstone', () => {
  it('writes a #tombstone row keyed to the DID', async () => {
    const seq = await emitTombstone({ did: TEST_DID })
    const rows = await db
      .select()
      .from(repoSeq)
      .where(eq(repoSeq.seq, seq))
    const row = rows[0]!
    expect(row.eventType).toBe('#tombstone')
    expect(row.did).toBe(TEST_DID)
  })
})
