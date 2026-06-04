// XRPC handler: tools.ozone.setting.upsertOption
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/setting/upsertOption.json

import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { ozoneSettings } from '~/lib/db/schema'
import { encode } from '~/pds/codec'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  key: z.string().min(1).max(256),
  scope: z.enum(['instance', 'personal']),
  value: z.unknown(),
  description: z.string().max(2000).optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const valueBytes = (await encode(parsed.data.value)).bytes
  const managedByDid =
    parsed.data.scope === 'personal'
      ? auth.kind === 'admin'
        ? null
        : auth.did
      : null

  // Manual upsert because the unique index uses COALESCE on
  // managed_by_did, which drizzle's onConflict can't address directly.
  const where = and(
    eq(ozoneSettings.key, parsed.data.key),
    eq(ozoneSettings.scope, parsed.data.scope),
    managedByDid
      ? eq(ozoneSettings.managedByDid, managedByDid)
      : isNull(ozoneSettings.managedByDid),
  )
  const existing = await db
    .select({ key: ozoneSettings.key })
    .from(ozoneSettings)
    .where(where)
    .limit(1)

  if (existing.length === 0) {
    await pg.insert(ozoneSettings).values({
      key: parsed.data.key,
      scope: parsed.data.scope,
      managedByDid,
      value: valueBytes,
      description: parsed.data.description ?? null,
      lastUpdatedBy: auth.kind === 'admin' ? null : auth.did,
    })
  } else {
    await db
      .update(ozoneSettings)
      .set({
        value: valueBytes,
        description: parsed.data.description ?? null,
        lastUpdatedBy: auth.kind === 'admin' ? null : auth.did,
        updatedAt: sql`now()`,
      })
      .where(where)
  }

  return {
    option: {
      key: parsed.data.key,
      scope: parsed.data.scope,
      value: parsed.data.value,
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description }
        : {}),
      managerRole: 'tools.ozone.team.defs#roleAdmin',
      createdBy: auth.kind === 'admin' ? 'admin' : auth.did,
      lastUpdatedBy: auth.kind === 'admin' ? 'admin' : auth.did,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.setting.upsertOption'
