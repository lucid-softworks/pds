// XRPC handler: com.atproto.admin.getAuditLog
//
// Read back the admin audit trail. `admin_audit` accumulates one row per
// mutation under `com.atproto.admin.*` (see ~/pds/admin/audit). This is the
// matching read endpoint — `requireAdmin`-gated like the rest of the surface,
// returns rows newest-first with optional filters.
//
// Query params (all optional):
//   - limit       — page size, default 50, max 500
//   - cursor      — id (string) below which to fetch next; pass the previous
//                   page's `cursor`
//   - targetDid   — only entries whose `target_did` matches
//   - action      — only entries whose `action` column matches
//
// `params` on each row is decoded from DAG-CBOR and re-serialised into a
// JSON-safe form (CIDs → strings, Uint8Array → { $bytes: b64 }) so the
// console can read it back. We don't return the raw CBOR bytes.
//
// Not added to the bundled lexicon catalog (no admin lexicons are bundled);
// the dispatcher's validate-and-observe path is a no-op for this NSID.
//
// See chapter 19 — Moderation.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAdmin } from '~/pds/auth/middleware'
import {
  jsonSafe,
  listAuditEntries,
  type AuditAction,
} from '~/pds/admin/audit'

// Mirror the type's union so we can validate the `action` filter without
// importing zod just for one string field.
const KNOWN_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'getAccountInfo',
  'getAccountInfos',
  'updateAccountStatus',
  'updateAccountHandle',
  'updateAccountEmail',
  'sendEmail',
  'deleteAccount',
])

const handler: Handler = async ({ params, authorization }) => {
  await requireAdmin(authorization)
  let limit: number | undefined
  if (params.limit !== undefined) {
    const n = Number(params.limit)
    if (!Number.isFinite(n) || n <= 0) {
      throw BadRequest('limit must be a positive integer', 'InvalidRequest')
    }
    limit = Math.floor(n)
  }
  const cursor = params.cursor?.trim() || undefined
  const targetDid = params.targetDid?.trim() || undefined
  const actionParam = params.action?.trim() || undefined
  let action: AuditAction | undefined
  if (actionParam !== undefined) {
    if (!KNOWN_ACTIONS.has(actionParam as AuditAction)) {
      throw BadRequest(
        `unknown action: ${actionParam}`,
        'InvalidRequest',
      )
    }
    action = actionParam as AuditAction
  }
  const page = await listAuditEntries({
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(targetDid !== undefined ? { targetDid } : {}),
    ...(action !== undefined ? { action } : {}),
  })
  return {
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    entries: page.entries.map((row) => ({
      id: String(row.id),
      actor: row.actor,
      action: row.action,
      ...(row.targetDid !== null ? { targetDid: row.targetDid } : {}),
      params: jsonSafe(row.params),
      occurredAt: row.occurredAt.toISOString(),
      ...(row.ipAddr !== null ? { ipAddr: row.ipAddr } : {}),
      result: row.result,
      ...(row.errorMessage !== null
        ? { errorMessage: row.errorMessage }
        : {}),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.admin.getAuditLog'
