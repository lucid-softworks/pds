// XRPC handler: tools.ozone.safelink.queryEvents
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/safelink/queryEvents.json

import { and, asc, desc, gt, inArray, lt } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { safelinkEvents } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const MAX_LIMIT = 250
const DEFAULT_LIMIT = 50

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const n = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
      throw BadRequest(`limit must be 1..${MAX_LIMIT}`, 'InvalidRequest')
    }
    limit = n
  }
  const cursor = params.cursor?.trim()
  const sort = params.sortDirection?.trim() === 'asc' ? 'asc' : 'desc'

  const urls = parseList(params.urls)
  const patterns = parseList(params.patterns)

  const cursorId =
    cursor !== undefined ? Number.parseInt(cursor, 10) : undefined
  if (cursor !== undefined && (cursorId === undefined || !Number.isFinite(cursorId))) {
    throw BadRequest('invalid cursor', 'InvalidRequest')
  }

  const where = and(
    urls.length > 0 ? inArray(safelinkEvents.url, urls) : undefined,
    patterns.length > 0 ? inArray(safelinkEvents.pattern, patterns) : undefined,
    cursorId !== undefined
      ? sort === 'desc'
        ? lt(safelinkEvents.id, cursorId)
        : gt(safelinkEvents.id, cursorId)
      : undefined,
  )

  const rows = await db
    .select()
    .from(safelinkEvents)
    .where(where)
    .orderBy(sort === 'desc' ? desc(safelinkEvents.id) : asc(safelinkEvents.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    events: page.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      url: r.url,
      pattern: r.pattern,
      ...(r.action !== null ? { action: r.action } : {}),
      ...(r.reason !== null ? { reason: r.reason } : {}),
      ...(r.comment !== null ? { comment: r.comment } : {}),
      createdBy: r.createdBy ?? 'admin',
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.safelink.queryEvents'
