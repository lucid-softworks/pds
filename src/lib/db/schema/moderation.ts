import {
  pgTable,
  text,
  bigserial,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'

// ─── moderation_reports ───────────────────────────────────────────────────
//
// One row per `com.atproto.moderation.createReport` call. The PDS isn't a
// moderation service — reports are forwarded to an upstream mod service
// when one is configured (`PDS_MOD_SERVICE_DID`). We persist locally so
// the operator console has an audit trail even when the upstream is
// unreachable, and so the endpoint can mint a stable id every time.
//
// `subjectType` carries the lexicon $type discriminator:
//   - 'com.atproto.admin.defs#repoRef'  → subjectDid set
//   - 'com.atproto.repo.strongRef'      → subjectUri + subjectCid set
//
// See chapter 19 — Moderation.
export const moderationReports = pgTable(
  'moderation_reports',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    reportedByDid: text('reported_by_did').notNull(),
    reasonType: text('reason_type').notNull(),
    reason: text('reason'),
    subjectType: text('subject_type').notNull(),
    subjectDid: text('subject_did'),
    subjectUri: text('subject_uri'),
    subjectCid: text('subject_cid'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    createdIdx: index('moderation_reports_created_idx').on(t.createdAt),
    reporterIdx: index('moderation_reports_reporter_idx').on(
      t.reportedByDid,
      t.createdAt,
    ),
  }),
)

export type ModerationReportRow = typeof moderationReports.$inferSelect
export type NewModerationReportRow = typeof moderationReports.$inferInsert
