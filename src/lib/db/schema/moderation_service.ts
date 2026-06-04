import {
  pgTable,
  text,
  bigserial,
  bigint,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'
import { bytea } from './_columns'

// ─── mod_team ─────────────────────────────────────────────────────────────
//
// Roster of accounts authorised to operate the moderation surface. Auto-
// seeded from PDS_MOD_TEAM_HANDLE at startup; additional moderators are
// added by the lead through the /mod UI. Admin Basic auth bypasses this
// table — the operator with the admin password is always allowed.
//
// See chapter 24 — Ozone-shaped moderation.
export const modTeam = pgTable('mod_team', {
  did: text('did').primaryKey(),
  role: text('role').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  addedBy: text('added_by'),
})

// ─── mod_events ───────────────────────────────────────────────────────────
//
// Append-only event log. Mirrors Ozone's `mod_events` table.
//
// See chapter 24 — Ozone-shaped moderation.
export const modEvents = pgTable(
  'mod_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventType: text('event_type').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectDid: text('subject_did'),
    subjectUri: text('subject_uri'),
    subjectCid: text('subject_cid'),
    subjectBlobCids: text('subject_blob_cids').array(),
    comment: text('comment'),
    metadata: bytea('metadata').notNull(),
    createdByDid: text('created_by_did').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    subjectDidIdx: index('mod_events_subject_did_idx').on(
      t.subjectDid,
      t.createdAt,
    ),
    subjectUriIdx: index('mod_events_subject_uri_idx').on(
      t.subjectUri,
      t.createdAt,
    ),
    createdAtIdx: index('mod_events_created_at_idx').on(t.createdAt),
    eventTypeIdx: index('mod_events_event_type_idx').on(
      t.eventType,
      t.createdAt,
    ),
    createdByIdx: index('mod_events_created_by_idx').on(
      t.createdByDid,
      t.createdAt,
    ),
  }),
)

// ─── mod_subject_status ───────────────────────────────────────────────────
//
// Cache of the *current* state of every actioned subject. Powers
// `tools.ozone.moderation.queryStatuses`.
//
// See chapter 24 — Ozone-shaped moderation.
export const modSubjectStatus = pgTable(
  'mod_subject_status',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    subjectType: text('subject_type').notNull(),
    subjectDid: text('subject_did').notNull(),
    subjectUri: text('subject_uri'),
    subjectCid: text('subject_cid'),
    takedownEventId: bigint('takedown_event_id', { mode: 'number' }),
    reviewState: text('review_state').default('open').notNull(),
    lastComment: text('last_comment'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Uniqueness lives in a COALESCE-aware index defined alongside the
    // table in the migration — drizzle's typed index builder doesn't
    // express NULL-folding so we don't redeclare it here.
    reviewStateIdx: index('mod_subject_status_review_state_idx').on(
      t.reviewState,
      t.lastEventAt,
    ),
  }),
)

// ─── labels ───────────────────────────────────────────────────────────────
//
// Signed atproto labels emitted by `modEventLabel`. The labeler surface
// (`com.atproto.label.queryLabels`) reads these. Each row is signed
// with the mod-team lead's atproto signing key.
//
// See chapter 24 — Ozone-shaped moderation.
export const labels = pgTable(
  'labels',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    src: text('src').notNull(),
    uri: text('uri').notNull(),
    cid: text('cid'),
    val: text('val').notNull(),
    neg: boolean('neg').default(false).notNull(),
    cts: timestamp('cts', { withTimezone: true }).defaultNow().notNull(),
    exp: timestamp('exp', { withTimezone: true }),
    sig: bytea('sig').notNull(),
  },
  (t) => ({
    uriValIdx: index('labels_uri_val_idx').on(t.uri, t.val, t.seq),
    srcIdx: index('labels_src_idx').on(t.src, t.seq),
  }),
)

export type ModTeamMember = typeof modTeam.$inferSelect
export type NewModTeamMember = typeof modTeam.$inferInsert
export type ModEvent = typeof modEvents.$inferSelect
export type NewModEvent = typeof modEvents.$inferInsert
export type ModSubjectStatus = typeof modSubjectStatus.$inferSelect
export type NewModSubjectStatus = typeof modSubjectStatus.$inferInsert
export type Label = typeof labels.$inferSelect
export type NewLabel = typeof labels.$inferInsert
