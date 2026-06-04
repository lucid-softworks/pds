import {
  pgTable,
  text,
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
