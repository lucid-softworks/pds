import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// ─── reserved_keys ─────────────────────────────────────────────────────────
//
// Holding pen for signing keys that a destination PDS has pre-generated for a
// migrating account *before* the account row exists. The user puts the
// reserved public key in their PLC rotate op so the new PDS can sign commits
// on their behalf once they land.
//
// No FK to `accounts`: at reservation time the account does not yet exist on
// this PDS — that's the whole point. When createAccount later accepts a
// pre-existing DID (a follow-up — see chapter 20's gap list), it will look up
// the reserved row by `did` and use it instead of generating a fresh keypair.
//
// See chapter 20 — Migration.
export const reservedKeys = pgTable('reserved_keys', {
  did: text('did').primaryKey(),
  signingKeyPriv: text('signing_key_priv').notNull(),
  signingKeyPub: text('signing_key_pub').notNull(),
  reservedAt: timestamp('reserved_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export type ReservedKey = typeof reservedKeys.$inferSelect
export type NewReservedKey = typeof reservedKeys.$inferInsert
