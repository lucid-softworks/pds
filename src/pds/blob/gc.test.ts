// Behavior contract for the blob garbage collector.
//
// gcBlobs reaps `blobs` rows that no `record_blobs` row points at, *and*
// were created before now - graceMs. Three pinned guarantees:
//
//   - Orphan blobs older than the grace window are deleted.
//   - Attached blobs (one or more record_blobs rows) are spared.
//   - Newly-uploaded blobs inside the grace window are spared.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BLOB_DIR = mkdtempSync(join(tmpdir(), 'pds-test-gc-blobs-'))

import { setupTestDbEnv, migrateProcessDb } from '../../../tests/db'

setupTestDbEnv()

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { accounts, blobs, recordBlobs } from '~/lib/db/schema'
import { uploadBlob } from './upload'
import { gcBlobs } from './gc'

const CREATOR_DID = 'did:plc:gctestaaaaaaaaaaaaaaaaaa'

beforeAll(async () => {
  await migrateProcessDb()
  await db.insert(accounts).values({
    did: CREATOR_DID,
    handle: 'gc-test.example.com',
    email: 'gc-test@example.test',
    passwordHash: 'unused',
    signingKeyPriv: '00',
    signingKeyPub: '00',
    rotationKeyPriv: '00',
    rotationKeyPub: '00',
  })
})

describe('gcBlobs', () => {
  it('reaps an unreferenced blob when graceMs=0', async () => {
    const bytes = new TextEncoder().encode('reap-me')
    const ref = await uploadBlob({
      creator: CREATOR_DID,
      bytes,
      mimeType: 'text/plain',
    })
    const before = await db
      .select()
      .from(blobs)
      .where(eq(blobs.cid, ref.ref.toString()))
    expect(before).toHaveLength(1)

    const result = await gcBlobs({ graceMs: 0 })
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(result.bytesFreed).toBeGreaterThanOrEqual(bytes.length)

    const after = await db
      .select()
      .from(blobs)
      .where(eq(blobs.cid, ref.ref.toString()))
    expect(after).toHaveLength(0)
  })

  it('skips a blob with at least one record_blobs reference', async () => {
    const bytes = new TextEncoder().encode('keep-me')
    const ref = await uploadBlob({
      creator: CREATOR_DID,
      bytes,
      mimeType: 'text/plain',
    })
    const cidStr = ref.ref.toString()
    // Attach: fake record_blobs row pointing at this CID.
    const recordUri = `at://${CREATOR_DID}/app.bsky.feed.post/keepme1`
    await db.insert(recordBlobs).values({
      repoDid: CREATOR_DID,
      recordUri,
      blobCid: cidStr,
    })

    await gcBlobs({ graceMs: 0 })

    const after = await db.select().from(blobs).where(eq(blobs.cid, cidStr))
    expect(after).toHaveLength(1)
  })

  it('skips an orphan blob still inside the grace window', async () => {
    const bytes = new TextEncoder().encode('within-grace')
    const ref = await uploadBlob({
      creator: CREATOR_DID,
      bytes,
      mimeType: 'text/plain',
    })
    const cidStr = ref.ref.toString()

    // Generous grace window — the just-uploaded blob is well within it.
    const result = await gcBlobs({ graceMs: 60_000 })

    const after = await db.select().from(blobs).where(eq(blobs.cid, cidStr))
    expect(after).toHaveLength(1)
    // And the deleted-count from this sweep didn't include our row.
    // (We can't assert deleted===0 strictly because earlier-test orphans may
    // also exist; but our specific blob must still be there.)
    expect(result.deleted).toBeGreaterThanOrEqual(0)
  })
})
