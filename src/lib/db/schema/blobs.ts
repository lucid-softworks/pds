import {
  pgTable,
  text,
  bigint,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

// ─── blobs ─────────────────────────────────────────────────────────────────
//
// One row per uploaded blob. The bytes themselves live in the configured
// BlobStore backend (filesystem in dev, S3 in prod); this table is the
// metadata layer that lets us look a blob up by CID, enforce ownership for
// serving, and drive garbage collection.
//
// Blobs are addressed by CID, but unlike MST blocks they use the `raw`
// multicodec (0x55) rather than dag-cbor — the bytes aren't structured.
//
// See chapter 15 — Blobs.
export const blobs = pgTable(
  'blobs',
  {
    cid: text('cid').primaryKey(),
    creator: text('creator')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    mimeType: text('mime_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    // Opaque key the backend uses to read the bytes back — filesystem path
    // suffix or S3 object key. The application never parses this; only the
    // store implementation does.
    storeKey: text('store_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    creatorIdx: index('blobs_creator_idx').on(t.creator),
  }),
)

// ─── record_blobs ──────────────────────────────────────────────────────────
//
// Join table: which records reference which blobs. The records subsystem
// populates this at write time so we can answer "is this blob still in use?"
// during GC. Without these rows we'd have to scan every record body on every
// sweep.
//
// See chapter 15 — Blobs.
export const recordBlobs = pgTable(
  'record_blobs',
  {
    repoDid: text('repo_did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    recordUri: text('record_uri').notNull(),
    blobCid: text('blob_cid').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.repoDid, t.recordUri, t.blobCid] }),
    blobCidIdx: index('record_blobs_blob_cid_idx').on(t.blobCid),
  }),
)

export type Blob = typeof blobs.$inferSelect
export type NewBlob = typeof blobs.$inferInsert
export type RecordBlob = typeof recordBlobs.$inferSelect
export type NewRecordBlob = typeof recordBlobs.$inferInsert
