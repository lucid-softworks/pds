// XRPC handler: tools.ozone.safelink.removeRule
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/safelink/removeRule.json

import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { safelinkEvents, safelinkRules } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  url: z.string().min(1),
  pattern: z.enum(['domain', 'url']),
  comment: z.string().max(2000).optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const where = and(
    eq(safelinkRules.url, parsed.data.url),
    eq(safelinkRules.pattern, parsed.data.pattern),
  )
  const existing = (await db.select().from(safelinkRules).where(where).limit(1))[0]
  if (!existing) {
    throw NotFound(
      `rule not found: ${parsed.data.pattern}/${parsed.data.url}`,
      'RuleNotFound',
    )
  }
  await db.delete(safelinkRules).where(where)
  const actor = auth.kind === 'admin' ? null : auth.did
  const eventRow = await pg
    .insert(safelinkEvents)
    .values({
      eventType: 'removeRule',
      url: parsed.data.url,
      pattern: parsed.data.pattern,
      action: existing.action,
      reason: existing.reason,
      comment: parsed.data.comment ?? null,
      createdBy: actor,
    })
    .returning({
      id: safelinkEvents.id,
      createdAt: safelinkEvents.createdAt,
    })
  return {
    id: eventRow[0]!.id,
    eventType: 'removeRule',
    url: parsed.data.url,
    pattern: parsed.data.pattern,
    action: existing.action,
    reason: existing.reason,
    ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
    createdBy: actor ?? 'admin',
    createdAt: eventRow[0]!.createdAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.safelink.removeRule'
