import {
  pgTable,
  text,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

// ─── records ───────────────────────────────────────────────────────────────
//
// Flat index over every (collection, rkey) pair in every repo. The MST is the
// authoritative store; this table is a read cache so getRecord and listRecords
// don't have to walk the tree on every request.
//
// Drift is allowed in principle but never in practice: every applyWrites
// commits the MST mutation and the records-row mutations together. If the
// process crashes mid-write, the next startup can rebuild this table from the
// MST without losing data.
//
// See chapter 14 — Records.
export const records = pgTable(
  'records',
  {
    repoDid: text('repo_did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    rkey: text('rkey').notNull(),
    cid: text('cid').notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Operator-supplied identifier set by `admin.updateSubjectStatus`
    // when the record is taken down. NULL on visible records. The
    // record body stays in the repo (the MST commit doesn't rewind);
    // we only stop serving it from `repo.getRecord` and friends. See
    // chapter 19 — Moderation.
    takedownRef: text('takedown_ref'),
    // Commit rev (TID) at which this record-row last changed. Powers
    // read-after-write: the proxy compares this against the AppView's
    // `atproto-repo-rev` response header to find records that need
    // merging into proxied responses. See chapter 17.
    rev: text('rev'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.repoDid, t.collection, t.rkey] }),
    collectionIdx: index('records_repo_collection_idx').on(
      t.repoDid,
      t.collection,
    ),
    cidIdx: index('records_cid_idx').on(t.cid),
    revIdx: index('records_repo_rev_idx').on(t.repoDid, t.rev),
  }),
)

export type Record = typeof records.$inferSelect
export type NewRecord = typeof records.$inferInsert
