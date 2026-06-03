import {
  pgTable,
  text,
  bigserial,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'
import { bytea } from './_columns'

// ─── admin_audit ───────────────────────────────────────────────────────────
//
// Append-only trail of admin mutations. Every successful (and every failed)
// `com.atproto.admin.*` *mutation* — updateAccountStatus, updateAccountHandle,
// updateAccountEmail, sendEmail, deleteAccount — writes one row here. The
// read endpoints (getAccountInfo, getAccountInfos) are intentionally not
// audited: they fire on every console refresh and would drown the log.
//
// We don't (yet) differentiate between operators — every admin authenticates
// with the same Basic password, so `actor` is the string 'admin' for the
// HTTP Basic flow. A future "named operator credentials" surface would
// populate it with the operator's identifier.
//
// `params` holds the DAG-CBOR encoding of the handler's input. We pick CBOR
// over JSON.stringify so the on-disk form is deterministic and round-trips
// bytes / bigints cleanly — which matters as the audit table is the only
// surface that remembers what an admin actually called the endpoint with.
// The read endpoint decodes on the way out and re-serializes via JSON
// (CIDs → strings) so the caller sees readable values.
//
// See chapter 19 — Moderation.
export const adminAudit = pgTable(
  'admin_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Who performed the action. 'admin' for HTTP Basic admin auth (we don't
    // differentiate operators yet); a future multi-operator surface would
    // populate this with an operator id.
    actor: text('actor').notNull(),
    // Handler name without the lexicon prefix: e.g. 'updateAccountStatus'.
    action: text('action').notNull(),
    // DID the action affects, when applicable. NULL for actions that don't
    // address a single account (none today, but room to grow).
    targetDid: text('target_did'),
    // DAG-CBOR-encoded snapshot of the handler input. Deterministic, byte-
    // safe, and trivially decoded for display on the read side.
    params: bytea('params').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Best-effort client IP, pulled from x-forwarded-for / x-real-ip headers
    // by the wrapper. Null if the request didn't carry either header.
    ipAddr: text('ip_addr'),
    // 'ok' | 'error'. Failures are logged so a takedown attempt that 404s
    // (typo'd DID) still leaves a footprint.
    result: text('result').notNull(),
    errorMessage: text('error_message'),
  },
  (t) => ({
    // "give me the last N actions" — the operator console's default view.
    occurredIdx: index('admin_audit_occurred_idx').on(t.occurredAt),
    // Per-account history — "what did the admin team do to this DID?".
    targetIdx: index('admin_audit_target_occurred_idx').on(
      t.targetDid,
      t.occurredAt,
    ),
  }),
)

export type AdminAuditRow = typeof adminAudit.$inferSelect
export type NewAdminAuditRow = typeof adminAudit.$inferInsert
