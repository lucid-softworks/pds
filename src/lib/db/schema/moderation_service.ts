import {
  pgTable,
  text,
  bigserial,
  bigint,
  boolean,
  integer,
  jsonb,
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
    // modEventTag emissions accumulate here. Free-form strings — the
    // upstream Ozone UI uses them as user-defined categories.
    tags: text('tags').array(),
    // modEventPriorityScore sets this. 0..100; null = unset.
    priorityScore: integer('priority_score'),
    // 'open' | 'resolved' | null. Flipped to 'resolved' by
    // modEventResolveAppeal.
    appealState: text('appeal_state'),
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

// ─── mod_muted_reporters ──────────────────────────────────────────────────
//
// DIDs whose moderation_reports rows are de-emphasised in the operator
// queue. Flipped by modEventMuteReporter / modEventUnmuteReporter.
// Consumers join against this table to filter; the reports themselves
// stay visible to a deliberate query.
export const modMutedReporters = pgTable('mod_muted_reporters', {
  did: text('did').primaryKey(),
  mutedAt: timestamp('muted_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  mutedBy: text('muted_by'),
  comment: text('comment'),
})

// ─── mod_report_resolution ────────────────────────────────────────────────
//
// Links each moderation_reports row to the mod_events row that closed
// it. The /mod dashboard's "open reports" count joins against this
// table (left-join + IS NULL) to get the exact open-set rather than
// approximating via subject-takedown status.
//
// See chapter 24 — Ozone-shaped moderation.
export const modReportResolution = pgTable(
  'mod_report_resolution',
  {
    reportId: bigint('report_id', { mode: 'number' }).primaryKey(),
    eventId: bigint('event_id', { mode: 'number' }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedBy: text('resolved_by'),
  },
  (t) => ({
    eventIdx: index('mod_report_resolution_event_idx').on(t.eventId),
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
export type ModReportResolution = typeof modReportResolution.$inferSelect
export type NewModReportResolution = typeof modReportResolution.$inferInsert
export type ModMutedReporter = typeof modMutedReporters.$inferSelect
export type NewModMutedReporter = typeof modMutedReporters.$inferInsert

// ─── mod_scheduled_actions ────────────────────────────────────────────────
//
// Deferred-execution moderation actions. The sweeper polls this table
// and fires due rows by calling applyEmitEvent. Pending → completed /
// cancelled / failed state machine.
//
// See chapter 24 — Ozone-shaped moderation (Scheduled actions).
export const modScheduledActions = pgTable(
  'mod_scheduled_actions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actionType: text('action_type').notNull(),
    subjectDid: text('subject_did').notNull(),
    firesAt: timestamp('fires_at', { withTimezone: true }).notNull(),
    state: text('state').default('pending').notNull(),
    payload: bytea('payload').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }),
    failedReason: text('failed_reason'),
  },
  (t) => ({
    subjectIdx: index('mod_scheduled_actions_subject_idx').on(t.subjectDid),
  }),
)

export type ModScheduledAction = typeof modScheduledActions.$inferSelect
export type NewModScheduledAction = typeof modScheduledActions.$inferInsert

// ─── mod_queues ───────────────────────────────────────────────────────────
//
// Operator-defined moderation queues. Each queue is a named bucket of
// (subject-type, report-type) routing rules. `tools.ozone.queue.routeReports`
// auto-routes new reports to whichever enabled queue matches.
//
// See chapter 24 — Ozone-shaped moderation (Queues).
export const modQueues = pgTable(
  'mod_queues',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull().unique(),
    description: text('description'),
    subjectTypes: text('subject_types').array().notNull(),
    reportTypes: text('report_types').array().notNull(),
    collection: text('collection'),
    enabled: boolean('enabled').default(true).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    enabledIdx: index('mod_queues_enabled_idx').on(t.enabled),
  }),
)

export const modQueueAssignments = pgTable(
  'mod_queue_assignments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    queueId: bigint('queue_id', { mode: 'number' }).notNull(),
    did: text('did').notNull(),
    startAt: timestamp('start_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    endAt: timestamp('end_at', { withTimezone: true }),
  },
  (t) => ({
    queueIdx: index('mod_queue_assignments_queue_idx').on(t.queueId, t.endAt),
    didIdx: index('mod_queue_assignments_did_idx').on(t.did, t.endAt),
  }),
)

export type ModQueue = typeof modQueues.$inferSelect
export type NewModQueue = typeof modQueues.$inferInsert
export type ModQueueAssignment = typeof modQueueAssignments.$inferSelect
export type NewModQueueAssignment = typeof modQueueAssignments.$inferInsert

// ─── mod_report_activities ────────────────────────────────────────────────
//
// Append-only activity log per `moderation_reports` row. Drives the
// `tools.ozone.report.*` surface (createActivity / listActivities).
// activity_type ∈ {queue, assignment, escalation, close, reopen, note}.
// previous_status captures the report's status at activity time so the
// timeline shows transitions.
//
// See chapter 24 — Ozone-shaped moderation (Reports).
export const modReportActivities = pgTable(
  'mod_report_activities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    reportId: bigint('report_id', { mode: 'number' }).notNull(),
    activityType: text('activity_type').notNull(),
    previousStatus: text('previous_status'),
    internalNote: text('internal_note'),
    publicNote: text('public_note'),
    meta: jsonb('meta'),
    isAutomated: boolean('is_automated').default(false).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    reportIdx: index('mod_report_activities_report_idx').on(t.reportId, t.id),
  }),
)

export type ModReportActivity = typeof modReportActivities.$inferSelect
export type NewModReportActivity = typeof modReportActivities.$inferInsert
