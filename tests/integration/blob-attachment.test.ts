// End-to-end blob lifecycle, bypassing HTTP.
//
//   uploadBlob → applyWrites(create with the ref) →
//   record_blobs row appears → applyWrites(delete) →
//   record_blobs row gone → gcBlobs(graceMs=0) → blobs row gone.
//
// We use the upload/applyWrites orchestrators directly, exactly the way the
// XRPC handlers do, so the test pins the wiring without the HTTP layer's
// content-type and base64 plumbing.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BLOB_DIR = mkdtempSync(join(tmpdir(), 'pds-test-blob-int-'))

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { blobs, recordBlobs } from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { uploadBlob } from '~/pds/blob/upload'
import { gcBlobs } from '~/pds/blob/gc'
import { applyWrites } from '~/pds/repo/writes'

beforeAll(async () => {
  await migrateProcessDb()
})

describe('end-to-end blob attachment', () => {
  const handle = `bobby-${Date.now()}.example.com`
  const email = `bobby-${Date.now()}@example.test`
  const password = 'correct horse battery staple'

  let did: string
  let blobCidStr: string
  let recordUri: string

  it('createAccount succeeds', async () => {
    const result = await createAccount({ handle, email, password })
    did = result.did
    expect(did).toMatch(/^did:plc:/)
  })

  it('uploadBlob persists a metadata row and returns a CID ref', async () => {
    const bytes = new TextEncoder().encode('hello from the blob integration test')
    const ref = await uploadBlob({
      creator: did,
      bytes,
      mimeType: 'text/plain',
    })
    blobCidStr = ref.ref.toString()
    expect(blobCidStr).toMatch(/^bafkre/)
    const rows = await db.select().from(blobs).where(eq(blobs.cid, blobCidStr))
    expect(rows).toHaveLength(1)
  })

  it('applyWrites(create) with the blob ref inserts a record_blobs row', async () => {
    const result = await applyWrites({
      did,
      writes: [
        {
          action: 'create',
          collection: 'app.bsky.actor.profile',
          rkey: 'self',
          value: {
            $type: 'app.bsky.actor.profile',
            displayName: 'Bobby',
            avatar: {
              $type: 'blob',
              ref: { $link: blobCidStr },
              mimeType: 'text/plain',
              size: 36,
            },
          },
        },
      ],
    })
    expect(result.writes).toHaveLength(1)
    recordUri = result.writes[0]!.uri

    const rows = await db
      .select()
      .from(recordBlobs)
      .where(
        and(
          eq(recordBlobs.repoDid, did),
          eq(recordBlobs.recordUri, recordUri),
          eq(recordBlobs.blobCid, blobCidStr),
        ),
      )
    expect(rows).toHaveLength(1)
  })

  it('applyWrites(delete) removes the record_blobs row', async () => {
    await applyWrites({
      did,
      writes: [
        {
          action: 'delete',
          collection: 'app.bsky.actor.profile',
          rkey: 'self',
        },
      ],
    })
    const rows = await db
      .select()
      .from(recordBlobs)
      .where(
        and(
          eq(recordBlobs.repoDid, did),
          eq(recordBlobs.recordUri, recordUri),
        ),
      )
    expect(rows).toHaveLength(0)
  })

  it('gcBlobs(graceMs=0) reaps the now-orphaned blob row', async () => {
    // The blob row is unreferenced (the record was just deleted) and the
    // grace window is zero, so it's a candidate.
    await gcBlobs({ graceMs: 0 })
    const rows = await db.select().from(blobs).where(eq(blobs.cid, blobCidStr))
    expect(rows).toHaveLength(0)
  })
})
