// XRPC handler: tools.ozone.safelink.updateRule
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/safelink/updateRule.json

import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
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
  action: z.enum(['block', 'warn', 'whitelist']).optional(),
  reason: z.string().min(1).max(64).optional(),
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
  const actor = auth.kind === 'admin' ? null : auth.did
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
  const patch: Record<string, unknown> = {
    updatedAt: sql`now()`,
    lastUpdatedBy: actor,
  }
  if (parsed.data.action !== undefined) patch.action = parsed.data.action
  if (parsed.data.reason !== undefined) patch.reason = parsed.data.reason
  if (parsed.data.comment !== undefined)
    patch.comment = parsed.data.comment
  await db.update(safelinkRules).set(patch).where(where)
  const eventRow = await pg
    .insert(safelinkEvents)
    .values({
      eventType: 'updateRule',
      url: parsed.data.url,
      pattern: parsed.data.pattern,
      action: parsed.data.action ?? existing.action,
      reason: parsed.data.reason ?? existing.reason,
      comment: parsed.data.comment ?? existing.comment ?? null,
      createdBy: actor,
    })
    .returning({
      id: safelinkEvents.id,
      createdAt: safelinkEvents.createdAt,
    })
  return {
    id: eventRow[0]!.id,
    eventType: 'updateRule',
    url: parsed.data.url,
    pattern: parsed.data.pattern,
    action: parsed.data.action ?? existing.action,
    reason: parsed.data.reason ?? existing.reason,
    ...(parsed.data.comment ?? existing.comment
      ? { comment: parsed.data.comment ?? existing.comment! }
      : {}),
    createdBy: actor ?? 'admin',
    createdAt: eventRow[0]!.createdAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.safelink.updateRule'
