// XRPC handler: tools.ozone.verification.listVerifications
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/verification/listVerifications.json

import { and, asc, desc, gt, gte, inArray, lt, lte } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { verificationsIndex } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const MAX_LIMIT = 100
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

  const createdAfter = parseDate(params.createdAfter, 'createdAfter')
  const createdBefore = parseDate(params.createdBefore, 'createdBefore')
  const issuers = parseList(params.issuers)
  const subjects = parseList(params.subjects)

  const cursorId =
    cursor !== undefined
      ? new Date(cursor)
      : undefined
  if (cursor !== undefined && cursorId !== undefined && Number.isNaN(cursorId.getTime())) {
    throw BadRequest('cursor must be an ISO timestamp', 'InvalidRequest')
  }

  const where = and(
    issuers.length > 0
      ? inArray(verificationsIndex.issuerDid, issuers)
      : undefined,
    subjects.length > 0
      ? inArray(verificationsIndex.subjectDid, subjects)
      : undefined,
    createdAfter
      ? gte(verificationsIndex.createdAt, createdAfter)
      : undefined,
    createdBefore
      ? lte(verificationsIndex.createdAt, createdBefore)
      : undefined,
    cursorId !== undefined
      ? sort === 'desc'
        ? lt(verificationsIndex.createdAt, cursorId)
        : gt(verificationsIndex.createdAt, cursorId)
      : undefined,
  )

  const rows = await db
    .select()
    .from(verificationsIndex)
    .where(where)
    .orderBy(
      sort === 'desc'
        ? desc(verificationsIndex.createdAt)
        : asc(verificationsIndex.createdAt),
    )
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.createdAt.toISOString()
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    verifications: page.map((r) => ({
      uri: r.uri,
      cid: r.cid,
      issuer: r.issuerDid,
      subject: r.subjectDid,
      handle: r.handle,
      ...(r.displayName !== null ? { displayName: r.displayName } : {}),
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

function parseDate(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined) return undefined
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    throw BadRequest(`${name} must be an ISO timestamp`, 'InvalidRequest')
  }
  return d
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.verification.listVerifications'
