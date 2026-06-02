import {
  pgTable,
  text,
  boolean,
  timestamp,
  primaryKey,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

// ─── app_passwords ─────────────────────────────────────────────────────────
//
// Alternate credentials minted by an authenticated account for use in CLIs,
// bots, and any third-party tool that hasn't moved to OAuth. The hash format
// is identical to `accounts.password_hash` (scrypt:v1:...), so the same
// `verifyPassword` helper checks both.
//
// (did, name) is the natural key — a user reuses labels like 'cli' across
// accounts but never within their own. Index on `did` falls out of the
// composite PK.
//
// See chapter 13 — Authentication.
export const appPasswords = pgTable(
  'app_passwords',
  {
    did: text('did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    // false → narrow scope; we record the intent but don't yet enforce it
    // at the email-flow endpoints. See chapter 13.
    privileged: boolean('privileged').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.did, t.name] }),
  }),
)

export type AppPassword = typeof appPasswords.$inferSelect
export type NewAppPassword = typeof appPasswords.$inferInsert
