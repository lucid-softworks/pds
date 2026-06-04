// XRPC handler: tools.ozone.safelink.queryRules
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/safelink/queryRules.json

import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { safelinkRules } from '~/lib/db/schema'
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
  const patterns = parseList(params.patterns).filter(
    (p) => p === 'domain' || p === 'url',
  )
  const actions = parseList(params.actions).filter(
    (a) => a === 'block' || a === 'warn' || a === 'whitelist',
  )
  const reason = params.reason?.trim()

  const cursorClause =
    cursor !== undefined
      ? sort === 'desc'
        ? lt(safelinkRules.createdAt, new Date(cursor))
        : gt(safelinkRules.createdAt, new Date(cursor))
      : undefined

  const where = and(
    urls.length > 0 ? inArray(safelinkRules.url, urls) : undefined,
    patterns.length > 0 ? inArray(safelinkRules.pattern, patterns) : undefined,
    actions.length > 0 ? inArray(safelinkRules.action, actions) : undefined,
    reason ? eq(safelinkRules.reason, reason) : undefined,
    cursorClause,
  )

  const rows = await db
    .select()
    .from(safelinkRules)
    .where(where)
    .orderBy(
      sort === 'desc'
        ? desc(safelinkRules.createdAt)
        : asc(safelinkRules.createdAt),
    )
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.createdAt.toISOString()
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    rules: page.map((r) => ({
      url: r.url,
      pattern: r.pattern,
      action: r.action,
      reason: r.reason,
      ...(r.comment !== null ? { comment: r.comment } : {}),
      createdBy: r.lastUpdatedBy ?? 'admin',
      createdAt: r.createdAt.toISOString(),
      updatedBy: r.lastUpdatedBy ?? 'admin',
      updatedAt: r.updatedAt.toISOString(),
    })),
  }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.safelink.queryRules'
