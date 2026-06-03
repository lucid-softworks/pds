// Admin audit log — write / read helpers and a tiny handler wrapper.
//
// Every mutation under `com.atproto.admin.*` writes one row to `admin_audit`,
// successful or not, with a DAG-CBOR-encoded snapshot of its input. The
// matching read endpoint (`com.atproto.admin.getAuditLog`) lists rows back
// by descending id with optional filters on target DID and action name.
//
// The five mutations:
//   - updateAccountStatus
//   - updateAccountHandle
//   - updateAccountEmail
//   - sendEmail
//   - deleteAccount
//
// The two read endpoints (`getAccountInfo`, `getAccountInfos`) deliberately
// do NOT write: a console refresh would otherwise flood the table.
//
// CBOR-vs-JSON for `params`: the audit row is the only place we still hold
// what the admin actually said. JSON would discard Uint8Array and bigint as
// soon as either slipped in; DAG-CBOR encodes them byte-faithfully, is
// deterministic across runs, and is the same codec the rest of the PDS
// already uses (blocks, commits, events). The read endpoint decodes on the
// way out and re-stringifies via JSON-friendly conversion so console users
// see plain values.
//
// See chapter 19 — Moderation.

import { and, desc, eq, lt } from 'drizzle-orm'
import { CID } from 'multiformats/cid'
import { db } from '~/lib/db'
// Imported directly because the coordinator owns `~/lib/db/schema/index.ts`.
// Once they add the re-export this should switch to `from '~/lib/db/schema'`.
import { adminAudit, type AdminAuditRow } from '~/lib/db/schema'
import { decode, encode } from '~/pds/codec'
import type { Handler, HandlerCtx } from '~/pds/xrpc/server'

export type AuditAction =
  | 'getAccountInfo'
  | 'getAccountInfos'
  | 'updateAccountStatus'
  | 'updateAccountHandle'
  | 'updateAccountEmail'
  | 'sendEmail'
  | 'deleteAccount'

export type AuditResult = 'ok' | 'error'

/** Decoded shape returned by `listAuditEntries`. Mirrors `AdminAuditRow`
 *  but with `params` decoded back from CBOR. */
export type DecodedAuditEntry = {
  id: number
  actor: string
  action: string
  targetDid: string | null
  params: unknown
  occurredAt: Date
  ipAddr: string | null
  result: AuditResult
  errorMessage: string | null
}

/** Insert one row. Never throws — audit logging must not take down the
 *  handler it wraps. Errors are swallowed (and would be tracked by metrics
 *  in production); the caller's success/failure path is unaffected. */
export async function logAuditEntry(args: {
  actor: string
  action: AuditAction
  targetDid?: string
  params: unknown
  ipAddr?: string
  result: AuditResult
  errorMessage?: string
}): Promise<void> {
  try {
    const { bytes } = await encode(args.params ?? null)
    await db.insert(adminAudit).values({
      actor: args.actor,
      action: args.action,
      targetDid: args.targetDid ?? null,
      params: bytes,
      ipAddr: args.ipAddr ?? null,
      result: args.result,
      errorMessage: args.errorMessage ?? null,
    })
  } catch (err) {
    // Don't let audit-side failures break the request. A real deployment
    // would page on this; for the teaching port we log and move on.
    // eslint-disable-next-line no-console
    console.warn('[admin-audit] failed to write row', err)
  }
}

/** Read entries newest-first. Pagination on `id` desc (cursor is the
 *  smallest id from the previous page; rows with id < cursor are returned
 *  next). Optional `targetDid` / `action` filters. */
export async function listAuditEntries(args: {
  limit?: number
  cursor?: string
  targetDid?: string
  action?: AuditAction
}): Promise<{ entries: DecodedAuditEntry[]; cursor?: string }> {
  const max = 500
  const def = 50
  let limit = args.limit ?? def
  if (!Number.isFinite(limit) || limit <= 0) limit = def
  if (limit > max) limit = max

  type Cond = ReturnType<typeof eq>
  const filters: Cond[] = []
  if (args.cursor) {
    const parsed = Number(args.cursor)
    if (Number.isFinite(parsed) && parsed > 0) {
      filters.push(lt(adminAudit.id, parsed))
    }
  }
  if (args.targetDid) filters.push(eq(adminAudit.targetDid, args.targetDid))
  if (args.action) filters.push(eq(adminAudit.action, args.action))

  // `and(...[])` returns undefined, which drizzle treats as "no where clause"
  // — same effect as omitting `.where()` entirely. Keeps the code branchless.
  const rows = await db
    .select()
    .from(adminAudit)
    .where(and(...filters))
    .orderBy(desc(adminAudit.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const decoded: DecodedAuditEntry[] = []
  for (const row of page) {
    decoded.push({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetDid: row.targetDid,
      params: await safeDecode(row.params),
      occurredAt: row.occurredAt,
      ipAddr: row.ipAddr,
      result: row.result as AuditResult,
      errorMessage: row.errorMessage,
    })
  }
  const next = hasMore ? String(page[page.length - 1]!.id) : undefined
  return next === undefined ? { entries: decoded } : { entries: decoded, cursor: next }
}

async function safeDecode(bytes: Uint8Array): Promise<unknown> {
  try {
    // pglite returns Uint8Array; postgres-js returns Buffer (a subclass).
    // Both satisfy the decoder.
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    return await decode(view)
  } catch {
    // A row whose params don't decode is still worth showing — emit a
    // sentinel rather than crashing the listing.
    return { __undecodable: true, length: bytes.length }
  }
}

/** Convert a decoded-CBOR value into something `JSON.stringify` can hand to
 *  the lexicon outbound validator. CIDs become their string form; Uint8Array
 *  becomes `{ $bytes: base64 }`; everything else passes through. The shape
 *  is recursive on objects and arrays.
 *
 *  This isn't a generally-correct CBOR→JSON conversion — it's just enough
 *  to make the audit log readable in a JSON-only response envelope. */
export function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') }
  }
  if (CID.asCID(value)) {
    return (value as CID).toString()
  }
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = jsonSafe(v)
    }
    return out
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

/** Extract the requestor IP from common proxy headers. First entry of
 *  `x-forwarded-for` wins (the original client; subsequent entries are
 *  intermediaries), then `x-real-ip`. Returns `undefined` when neither
 *  header is set. */
export function extractIp(request: Request): string | undefined {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  return undefined
}

/** Wrap a handler so it always emits one audit row, ok or error. The handler
 *  body still owns auth + validation; the wrapper only adds a `try/finally`-
 *  shaped emit around it.
 *
 *  `targetDidFrom` reads from the same `input` / `params` the handler sees
 *  so the wrapper doesn't have to know per-handler input shapes. */
export function withAdminAudit(
  args: {
    action: AuditAction
    targetDidFrom: (
      input: unknown,
      params: Record<string, string>,
    ) => string | undefined
  },
  body: Handler,
): Handler {
  return async (ctx: HandlerCtx) => {
    const ipAddr = extractIp(ctx.request)
    // Snapshot exactly what reached the handler. For POSTs that's the
    // parsed JSON body; for GETs (none of the mutation surface today, but
    // the wrapper is shape-agnostic) it's the query string.
    const snapshot =
      ctx.input !== undefined && ctx.input !== null ? ctx.input : ctx.params
    const targetDid = args.targetDidFrom(ctx.input, ctx.params)
    try {
      const output = await body(ctx)
      await logAuditEntry({
        actor: 'admin',
        action: args.action,
        ...(targetDid !== undefined ? { targetDid } : {}),
        params: snapshot,
        ...(ipAddr !== undefined ? { ipAddr } : {}),
        result: 'ok',
      })
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await logAuditEntry({
        actor: 'admin',
        action: args.action,
        ...(targetDid !== undefined ? { targetDid } : {}),
        params: snapshot,
        ...(ipAddr !== undefined ? { ipAddr } : {}),
        result: 'error',
        errorMessage: message,
      })
      throw err
    }
  }
}
