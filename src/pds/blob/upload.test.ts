// Behavior contract for blob upload.
//
// Three pinned guarantees:
//   - uploadBlob stores bytes and persists a metadata row keyed by CID.
//   - Re-uploading the same bytes yields the same CID (content-addressing).
//   - The bytes are retrievable from the BlobStore via the stored storeKey.
//
// We use a fresh tmp BLOB_DIR per file. The store module caches its
// singleton, but vitest's per-file fork isolation means each test file gets
// a fresh module-graph.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Override BLOB_DIR *before* the config module's first read.
const BLOB_DIR = mkdtempSync(join(tmpdir(), 'pds-test-upload-blobs-'))
process.env.BLOB_DIR = BLOB_DIR

import { setupTestDbEnv, migrateProcessDb } from '../../../tests/db'

// IMPORTANT: must run before any import that touches `~/lib/db`.
setupTestDbEnv()

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { accounts, blobs } from '~/lib/db/schema'
import { uploadBlob } from './upload'
import { getBlobStore } from './store'

const CREATOR_DID = 'did:plc:uploadtestaaaaaaaaaaaaaa'

beforeAll(async () => {
  await migrateProcessDb()
  // Insert a minimal `accounts` row to satisfy the FK on `blobs.creator`.
  // Values here are otherwise unused by the upload path.
  await db.insert(accounts).values({
    did: CREATOR_DID,
    handle: 'upload-test.example.com',
    email: 'upload-test@example.test',
    passwordHash: 'unused',
    signingKeyPriv: '00',
    signingKeyPub: '00',
    rotationKeyPriv: '00',
    rotationKeyPub: '00',
  })
})

const helloBytes = new TextEncoder().encode('hello, blob!')
const otherBytes = new TextEncoder().encode('a different blob payload')

describe('uploadBlob', () => {
  it('stores bytes, returns a CID, inserts the metadata row', async () => {
    const ref = await uploadBlob({
      creator: CREATOR_DID,
      bytes: helloBytes,
      mimeType: 'text/plain',
    })
    expect(ref.$type).toBe('blob')
    expect(ref.mimeType).toBe('text/plain')
    expect(ref.size).toBe(helloBytes.length)
    expect(ref.ref.toString()).toMatch(/^bafkre/)

    const rows = await db
      .select()
      .from(blobs)
      .where(eq(blobs.cid, ref.ref.toString()))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.creator).toBe(CREATOR_DID)
    expect(rows[0]!.mimeType).toBe('text/plain')
    expect(rows[0]!.size).toBe(helloBytes.length)
    expect(rows[0]!.storeKey).toContain(ref.ref.toString())
  })

  it('the same bytes uploaded twice yield the same CID', async () => {
    const a = await uploadBlob({
      creator: CREATOR_DID,
      bytes: helloBytes,
      mimeType: 'text/plain',
    })
    const b = await uploadBlob({
      creator: CREATOR_DID,
      bytes: helloBytes,
      mimeType: 'text/plain',
    })
    expect(a.ref.toString()).toBe(b.ref.toString())
    // Only one metadata row exists for this CID (onConflictDoNothing).
    const rows = await db
      .select()
      .from(blobs)
      .where(eq(blobs.cid, a.ref.toString()))
    expect(rows).toHaveLength(1)
  })

  it('different bytes produce a different CID', async () => {
    const a = await uploadBlob({
      creator: CREATOR_DID,
      bytes: helloBytes,
      mimeType: 'text/plain',
    })
    const b = await uploadBlob({
      creator: CREATOR_DID,
      bytes: otherBytes,
      mimeType: 'text/plain',
    })
    expect(a.ref.toString()).not.toBe(b.ref.toString())
  })

  it('bytes are retrievable from the BlobStore via the metadata row', async () => {
    const ref = await uploadBlob({
      creator: CREATOR_DID,
      bytes: otherBytes,
      mimeType: 'application/octet-stream',
    })
    const rows = await db
      .select()
      .from(blobs)
      .where(eq(blobs.cid, ref.ref.toString()))
    const storeKey = rows[0]!.storeKey
    const store = getBlobStore()
    const got = await store.get(storeKey)
    expect(got).not.toBeNull()
    expect(Array.from(got!)).toEqual(Array.from(otherBytes))
  })

  it('persists the mimeType the caller supplied (round-trip)', async () => {
    const bytes = new TextEncoder().encode('mime-roundtrip')
    const ref = await uploadBlob({
      creator: CREATOR_DID,
      bytes,
      mimeType: 'image/png',
    })
    expect(ref.mimeType).toBe('image/png')
    const rows = await db
      .select()
      .from(blobs)
      .where(eq(blobs.cid, ref.ref.toString()))
    expect(rows[0]!.mimeType).toBe('image/png')
  })
})
