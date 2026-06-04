import {
  pgTable,
  text,
  bigserial,
  boolean,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core'
import { bytea } from './_columns'

// ─── ozone_settings ───────────────────────────────────────────────────────
//
// Key/value/scope operator config store. Mirrors Ozone's two scopes
// ('instance', 'personal') — instance is operator-global, personal is
// per-moderator keyed on `managedByDid`.
//
// See chapter 24 — Ozone-shaped moderation.
export const ozoneSettings = pgTable(
  'ozone_settings',
  {
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    managedByDid: text('managed_by_did'),
    value: bytea('value').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUpdatedBy: text('last_updated_by'),
  },
  (_t) => ({
    // Uniqueness is enforced by the COALESCE-aware unique index in the
    // migration; drizzle can't express it.
  }),
)

// ─── ozone_sets ───────────────────────────────────────────────────────────
//
// Named subject sets. Each set is a collection of opaque strings —
// usually DIDs or AT-URIs — that an operator groups together to apply
// policies to. The lexicon leaves the semantics of `value` open.
//
// See chapter 24 — Ozone-shaped moderation.
export const ozoneSets = pgTable('ozone_sets', {
  name: text('name').primaryKey(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const ozoneSetValues = pgTable(
  'ozone_set_values',
  {
    setName: text('set_name')
      .notNull()
      .references(() => ozoneSets.name, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.setName, t.value] }),
    valueIdx: index('ozone_set_values_value_idx').on(t.value),
  }),
)

export type OzoneSetting = typeof ozoneSettings.$inferSelect
export type NewOzoneSetting = typeof ozoneSettings.$inferInsert
export type OzoneSet = typeof ozoneSets.$inferSelect
export type NewOzoneSet = typeof ozoneSets.$inferInsert
export type OzoneSetValue = typeof ozoneSetValues.$inferSelect
export type NewOzoneSetValue = typeof ozoneSetValues.$inferInsert

// ─── ozone_comm_templates ─────────────────────────────────────────────────
//
// Canned operator-to-user email templates. The upstream Ozone UI lists
// these so moderators pick one when they emit `modEventEmail`; we ship
// the storage but the modEventEmail integration is left as an exercise
// in chapter 24.
export const ozoneCommTemplates = pgTable('ozone_comm_templates', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull().unique(),
  subject: text('subject').notNull(),
  contentMarkdown: text('content_markdown').notNull(),
  lang: text('lang'),
  disabled: boolean('disabled').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  lastUpdatedBy: text('last_updated_by'),
})

// ─── verifications_index ──────────────────────────────────────────────────
//
// One row per verification record issued by this labeler. The grant
// itself is a record in the issuer's repo at
// `app.bsky.graph.verification` — this table mirrors the indexable
// dimensions (issuer/subject) for fast filtered listVerifications.
export const verificationsIndex = pgTable(
  'verifications_index',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    issuerDid: text('issuer_did').notNull(),
    subjectDid: text('subject_did').notNull(),
    handle: text('handle').notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    subjectIdx: index('verifications_index_subject_idx').on(
      t.subjectDid,
      t.createdAt,
    ),
    issuerIdx: index('verifications_index_issuer_idx').on(
      t.issuerDid,
      t.createdAt,
    ),
  }),
)

export type OzoneCommTemplate = typeof ozoneCommTemplates.$inferSelect
export type NewOzoneCommTemplate = typeof ozoneCommTemplates.$inferInsert
export type VerificationIndex = typeof verificationsIndex.$inferSelect
export type NewVerificationIndex = typeof verificationsIndex.$inferInsert
