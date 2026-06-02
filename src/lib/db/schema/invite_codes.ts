import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

// ─── invite_codes ──────────────────────────────────────────────────────────
//
// One row per minted invite. Codes outlive their creator: if the account that
// minted a code is later deleted, the code stays usable (createdBy goes to
// NULL on cascade). Admin-minted codes carry createdBy = NULL from the start.
//
// `forAccount` is the optional recipient gate — when set, only that DID can
// redeem this code. NULL means anyone with the string can use it.
//
// `uses_remaining` is the decrement counter; `uses_total` is a monotonic
// audit count we never reset. A row is "spent" when uses_remaining = 0.
//
// See chapter 12 — Account creation.
export const inviteCodes = pgTable(
  'invite_codes',
  {
    code: text('code').primaryKey(),
    createdBy: text('created_by').references(() => accounts.did, {
      onDelete: 'set null',
    }),
    forAccount: text('for_account').references(() => accounts.did, {
      onDelete: 'set null',
    }),
    usesRemaining: integer('uses_remaining').default(1).notNull(),
    usesTotal: integer('uses_total').default(0).notNull(),
    disabled: boolean('disabled').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    createdByIdx: index('invite_codes_created_by_idx').on(t.createdBy),
    forAccountIdx: index('invite_codes_for_account_idx').on(t.forAccount),
  }),
)

// ─── invite_code_uses ──────────────────────────────────────────────────────
//
// Audit log of who redeemed which code. Composite PK on (code, usedBy) means
// the same DID can't double-count against the same code even if a retry
// races; the orchestrator additionally decrements `uses_remaining` in the
// same transaction, so the counter and the log stay in sync.
//
// FK cascades from `invite_codes`: if an operator hard-deletes a code, the
// audit rows go with it. We don't FK `usedBy` to accounts — codes are
// consumed *during* account creation, before the accounts row exists, so the
// reference would be temporarily dangling.
export const inviteCodeUses = pgTable(
  'invite_code_uses',
  {
    code: text('code').notNull(),
    usedBy: text('used_by').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.code, t.usedBy] }),
  }),
)

export type InviteCode = typeof inviteCodes.$inferSelect
export type NewInviteCode = typeof inviteCodes.$inferInsert
export type InviteCodeUse = typeof inviteCodeUses.$inferSelect
export type NewInviteCodeUse = typeof inviteCodeUses.$inferInsert
