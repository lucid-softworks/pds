// XRPC handler: tools.ozone.moderation.queryEvents
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/queryEvents.json
//
// Paginated read of `mod_events`. Filters in scope for v1:
//
//   - types          one or more `tools.ozone.moderation.defs#modEvent<X>`
//   - createdBy      moderator DID
//   - createdAfter   ISO datetime
//   - createdBefore  ISO datetime
//   - subject        repo DID or AT-URI (interpreted by `at://` prefix)
//   - sortDirection  'asc' | 'desc' (default 'desc')
//   - limit          1..100 (default 50)
//   - cursor         the last seen event id, exclusive
//
// Deferred filters (not in scope for v1): collections,
// includeAllUserRecords, addedLabels, removedLabels, addedTags, hasComment,
// reportTypes, ageAssuranceState. Listed in chapter 24 as the
// "filters worth growing into."
//
// Output shape mirrors the lexicon's `events: ModEventView[]` —
// reconstructed from the persisted DAG-CBOR snapshot.

import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modEvents } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { decode } from '~/pds/codec'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const parsed = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw BadRequest(
        `limit must be between 1 and ${MAX_LIMIT}`,
        'InvalidRequest',
      )
    }
    limit = parsed
  }

  const sortDirection = params.sortDirection?.trim() ?? 'desc'
  if (sortDirection !== 'asc' && sortDirection !== 'desc') {
    throw BadRequest(
      'sortDirection must be "asc" or "desc"',
      'InvalidRequest',
    )
  }
  const isDesc = sortDirection === 'desc'

  // Cursor encodes the id of the last row from the previous page.
  let cursorId: number | undefined
  if (params.cursor !== undefined) {
    const n = Number.parseInt(params.cursor, 10)
    if (!Number.isFinite(n) || n < 0) {
      throw BadRequest('invalid cursor', 'InvalidRequest')
    }
    cursorId = n
  }

  const types = parseTypesParam(params.types)
  const createdBy = params.createdBy?.trim()
  const createdAfter = parseTimestamp(params.createdAfter, 'createdAfter')
  const createdBefore = parseTimestamp(params.createdBefore, 'createdBefore')
  const subject = params.subject?.trim()

  // Subject param can be a DID (account scope) or an AT-URI (record
  // scope). We branch on the at:// prefix.
  let subjectCondition
  if (subject) {
    if (subject.startsWith('at://')) {
      subjectCondition = eq(modEvents.subjectUri, subject)
    } else if (/^did:/.test(subject)) {
      // Match repoRef events AND any strongRef event whose URI starts
      // with at://<did>/ — gives the operator "all events for this
      // account" in one query.
      subjectCondition = or(
        eq(modEvents.subjectDid, subject),
        sql`${modEvents.subjectUri} LIKE ${`at://${subject}/%`}`,
      )
    } else {
      throw BadRequest(
        'subject must be a DID or an AT-URI starting with at://',
        'InvalidRequest',
      )
    }
  }

  const cursorClause =
    cursorId === undefined
      ? undefined
      : isDesc
        ? lt(modEvents.id, cursorId)
        : gt(modEvents.id, cursorId)

  const whereClause = and(
    types.length > 0
      ? inArray(modEvents.eventType, types.map(stripPrefix))
      : undefined,
    createdBy ? eq(modEvents.createdByDid, createdBy) : undefined,
    createdAfter ? gte(modEvents.createdAt, createdAfter) : undefined,
    createdBefore ? lte(modEvents.createdAt, createdBefore) : undefined,
    subjectCondition,
    cursorClause,
  )

  const rows = await db
    .select()
    .from(modEvents)
    .where(whereClause)
    .orderBy(isDesc ? desc(modEvents.id) : asc(modEvents.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  const events = await Promise.all(page.map(eventViewFromRow))
  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    events,
  }
}

function parseTypesParam(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

function parseTimestamp(
  raw: string | undefined,
  paramName: string,
): Date | undefined {
  if (raw === undefined) return undefined
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw BadRequest(
      `${paramName} must be an ISO datetime`,
      'InvalidRequest',
    )
  }
  return date
}

function stripPrefix(typ: string): string {
  const hashIdx = typ.indexOf('#')
  return hashIdx >= 0 ? typ.slice(hashIdx + 1) : typ
}

async function eventViewFromRow(row: typeof modEvents.$inferSelect) {
  // The original input is round-trippable via the DAG-CBOR snapshot.
  // Decoding gives us back the exact lexicon shape (event union +
  // subject union) the caller submitted.
  const snapshot = await decode<Record<string, unknown>>(row.metadata)
  return {
    id: row.id,
    event: snapshot.event,
    subject: snapshot.subject,
    subjectBlobCids: snapshot.subjectBlobCids ?? [],
    createdBy: row.createdByDid,
    createdAt: row.createdAt.toISOString(),
    creatorHandle: undefined as string | undefined,
    // ozone's response shape includes a `subjectHandle` too; we don't
    // resolve it here to keep the read cheap. The /mod UI joins it when
    // needed.
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.queryEvents'
