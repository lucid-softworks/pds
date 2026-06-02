import {
  pgTable,
  text,
  integer,
  bigint,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { bytea } from './_columns'

// ─── accounts ──────────────────────────────────────────────────────────────
//
// One row per account. The DID is the primary key; everything else hangs off
// it. Handles are mutable (a user can rename), so they're a separate column
// that we index for lookup. The signing key lives here because the PDS
// performs commit signatures on the user's behalf — losing this column means
// losing the account.
//
// See chapter 12 — Account creation.
export const accounts = pgTable(
  'accounts',
  {
    did: text('did').primaryKey(),
    handle: text('handle').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    // Hex-encoded 32-byte k256 private scalar. In a production system this
    // would be wrapped (KMS, age-encrypted file, …); for the teaching port
    // it's plaintext in Postgres and the docs flag it as such.
    signingKeyPriv: text('signing_key_priv').notNull(),
    // Multibase-encoded compressed public key, served in the DID document.
    signingKeyPub: text('signing_key_pub').notNull(),
    // Same shape, but for the *rotation* key — controls DID identity changes.
    rotationKeyPriv: text('rotation_key_priv').notNull(),
    rotationKeyPub: text('rotation_key_pub').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // 'active' | 'takendown' | 'deactivated' | 'deleted'
    status: text('status').default('active').notNull(),
    // Nullable: NULL means the address has never been confirmed. Set by
    // confirmEmail, cleared by updateEmail so the new address is reconfirmed.
    // See chapter 13 — Authentication.
    emailConfirmedAt: timestamp('email_confirmed_at', { withTimezone: true }),
  },
  (t) => ({
    handleIdx: uniqueIndex('accounts_handle_idx').on(t.handle),
    emailIdx: uniqueIndex('accounts_email_idx').on(t.email),
  }),
)

// ─── repos ─────────────────────────────────────────────────────────────────
//
// One row per repository. The repo's current state is fully described by
// (root commit CID, rev). We update this row atomically with every commit.
//
// See chapters 06–07 — MST and commits.
export const repos = pgTable('repos', {
  did: text('did')
    .primaryKey()
    .references(() => accounts.did, { onDelete: 'cascade' }),
  rootCid: text('root_cid').notNull(),
  rev: text('rev').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

// ─── repo_blocks ───────────────────────────────────────────────────────────
//
// Content-addressed block storage. Every encoded MST node and every signed
// commit lives here. The same block can be referenced by many commits across
// a repo's history (structural sharing); we don't deduplicate across repos
// because a block's bytes are tied to a single repo for GC purposes.
//
// See chapter 11 — Database schema.
export const repoBlocks = pgTable(
  'repo_blocks',
  {
    repoDid: text('repo_did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    cid: text('cid').notNull(),
    bytes: bytea('bytes').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.repoDid, t.cid] }),
    cidIdx: index('repo_blocks_cid_idx').on(t.cid),
  }),
)

// ─── refresh_tokens ────────────────────────────────────────────────────────
//
// Refresh JWTs are stateless to verify (signature only), but we persist their
// `jti` claim so we can revoke individual tokens without invalidating every
// session. The row is deleted on logout or rotation.
//
// See chapter 13 — Authentication.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    jti: text('jti').primaryKey(),
    did: text('did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    appPasswordName: text('app_password_name'),
  },
  (t) => ({
    didIdx: index('refresh_tokens_did_idx').on(t.did),
  }),
)

// ─── plc_operations ────────────────────────────────────────────────────────
//
// Local copy of the signed PLC operations for each account's DID. Each row is
// one operation in that DID's log; `cid` is the operation's content hash.
// In production these are published to plc.directory and resolved from there;
// in dev we keep them here so the PDS is fully self-contained.
//
// See chapter 12 — Account creation.
export const plcOperations = pgTable(
  'plc_operations',
  {
    did: text('did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    cid: text('cid').notNull(),
    operation: bytea('operation').notNull(),
    // Sequence: 0 is genesis, increments with each rotation.
    seq: bigint('seq', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.did, t.seq] }),
    cidIdx: index('plc_operations_cid_idx').on(t.cid),
  }),
)

export type Account = typeof accounts.$inferSelect
export type NewAccount = typeof accounts.$inferInsert
export type Repo = typeof repos.$inferSelect
export type NewRepo = typeof repos.$inferInsert
export type RepoBlock = typeof repoBlocks.$inferSelect
export type NewRepoBlock = typeof repoBlocks.$inferInsert
export type RefreshToken = typeof refreshTokens.$inferSelect
