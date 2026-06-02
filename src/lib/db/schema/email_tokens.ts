import {
  pgTable,
  text,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

// ─── email_tokens ──────────────────────────────────────────────────────────
//
// One row per outstanding email-action token: address confirmation, email
// change, and password reset. Each row is single-use; `consumeEmailToken`
// deletes on hit. Issuing a new token for the same (did, purpose) deletes
// any older one first — there is only ever a single live token per pair.
//
// The token itself is 32 chars of lowercase base32 (160 bits) — short enough
// to read aloud or paste from an email, long enough that brute force is
// infeasible at expected traffic.
//
// Password-reset submission doesn't carry a DID (the user is unauthenticated
// and only knows their email), so we add a secondary index on `token` to
// support purpose-scoped lookup by token alone.
//
// See chapter 13 — Authentication.
export const emailTokens = pgTable(
  'email_tokens',
  {
    did: text('did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    // 'confirm-email' | 'update-email' | 'reset-password'
    purpose: text('purpose').notNull(),
    token: text('token').notNull(),
    // Populated only for 'update-email' — the address the user is moving to.
    newEmail: text('new_email'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.did, t.purpose, t.token] }),
    tokenIdx: index('email_tokens_token_idx').on(t.token),
  }),
)

export type EmailToken = typeof emailTokens.$inferSelect
export type NewEmailToken = typeof emailTokens.$inferInsert
