// XRPC handler: tools.ozone.moderation.listScheduledActions
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/listScheduledActions.json

import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modScheduledActions } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { decode } from '~/pds/codec'

const MAX_LIMIT = 200
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
  const cursorId = cursor ? Number.parseInt(cursor, 10) : undefined
  if (cursor !== undefined && (cursorId === undefined || !Number.isFinite(cursorId))) {
    throw BadRequest('invalid cursor', 'InvalidRequest')
  }
  const states = parseList(params.states)
  const subjects = parseList(params.subjects)

  const where = and(
    states.length > 0
      ? inArray(modScheduledActions.state, states)
      : eq(modScheduledActions.state, 'pending'),
    subjects.length > 0
      ? inArray(modScheduledActions.subjectDid, subjects)
      : undefined,
    cursorId !== undefined ? gt(modScheduledActions.id, cursorId) : undefined,
  )

  const rows = await db
    .select()
    .from(modScheduledActions)
    .where(where)
    .orderBy(asc(modScheduledActions.firesAt))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  const decoded = await Promise.all(
    page.map(async (r) => ({
      id: String(r.id),
      actionType: r.actionType,
      subject: r.subjectDid,
      firesAt: r.firesAt.toISOString(),
      state: r.state,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      ...(r.firedAt !== null ? { firedAt: r.firedAt.toISOString() } : {}),
      ...(r.failedReason !== null ? { failedReason: r.failedReason } : {}),
      action: (await decode<Record<string, unknown>>(r.payload)).action,
    })),
  )
  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    actions: decoded,
  }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.listScheduledActions'
