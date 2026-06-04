// XRPC handler: tools.ozone.setting.listOptions
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/setting/listOptions.json

import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { ozoneSettings } from '~/lib/db/schema'
import { decode } from '~/pds/codec'
import { requireModerator } from '~/pds/mod/auth'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

const handler: Handler = async ({ params, authorization }) => {
  const auth = await requireModerator(authorization)

  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const n = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
      throw BadRequest(`limit must be 1..${MAX_LIMIT}`, 'InvalidRequest')
    }
    limit = n
  }
  const cursor = params.cursor?.trim()
  const scopeParam = params.scope?.trim()
  const scope =
    scopeParam === 'instance' || scopeParam === 'personal' ? scopeParam : null

  // For 'personal' scope, only this caller's own rows are visible.
  const personalDid = auth.kind === 'moderator' ? auth.did : null

  const where = and(
    scope ? eq(ozoneSettings.scope, scope) : undefined,
    scope === 'personal' && personalDid
      ? eq(ozoneSettings.managedByDid, personalDid)
      : scope === 'instance'
        ? isNull(ozoneSettings.managedByDid)
        : undefined,
    cursor ? gt(ozoneSettings.key, cursor) : undefined,
  )

  const rows = await db
    .select()
    .from(ozoneSettings)
    .where(where)
    .orderBy(asc(ozoneSettings.key))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.key
      : undefined

  const options = await Promise.all(
    page.map(async (r) => ({
      key: r.key,
      scope: r.scope,
      value: await decode(r.value),
      ...(r.description !== null ? { description: r.description } : {}),
      managerRole: 'tools.ozone.team.defs#roleAdmin',
      createdBy: r.lastUpdatedBy ?? 'admin',
      lastUpdatedBy: r.lastUpdatedBy ?? 'admin',
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  )
  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    options,
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.setting.listOptions'
