import {
  pgTable,
  text,
  bigserial,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'
import { bytea } from './_columns'

// ─── repo_seq ──────────────────────────────────────────────────────────────
//
// The firehose's source-of-truth log. Every event the PDS would publish on
// `com.atproto.sync.subscribeRepos` is first written here, then re-emitted to
// WebSocket subscribers from this same table on connect (historical replay)
// and via a tail on the latest seq (live).
//
// `seq` is a Postgres `bigserial` so insert ordering and id assignment line
// up: a row with seq=N committed before seq=N+1, end of story. Consumers
// index by it as a stable, monotonic cursor.
//
// `event` is the raw DAG-CBOR encoding of the event payload — exactly the
// bytes that would land inside a firehose frame. We store the encoded form
// (not JSON, not the structured columns re-derived) so the WebSocket handler
// can fetch a slice of rows and send them out without re-encoding.
//
// See chapter 16 — Event sequencer and the firehose.
export const repoSeq = pgTable(
  'repo_seq',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    did: text('did').notNull(),
    eventType: text('event_type').notNull(),
    event: bytea('event').notNull(),
    invalidated: boolean('invalidated').default(false).notNull(),
    sequencedAt: timestamp('sequenced_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    didSeqIdx: index('repo_seq_did_seq_idx').on(t.did, t.seq),
  }),
)

export type RepoSeq = typeof repoSeq.$inferSelect
export type NewRepoSeq = typeof repoSeq.$inferInsert
