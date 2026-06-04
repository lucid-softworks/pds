// XRPC handler: tools.ozone.safelink.addRule
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/safelink/addRule.json
//
// Upsert a URL-safety rule. The handler does NOT enforce "must not
// already exist" — the upstream Ozone API treats addRule as
// idempotent (re-applying with the same content is a no-op; re-applying
// with different content updates). Each call appends an event row.

import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { safelinkEvents, safelinkRules } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  url: z.string().min(1).max(2048),
  pattern: z.enum(['domain', 'url']),
  action: z.enum(['block', 'warn', 'whitelist']),
  reason: z.string().min(1).max(64),
  comment: z.string().max(2000).optional(),
  createdBy: z.string().optional(),
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
  const existing = (
    await db
      .select()
      .from(safelinkRules)
      .where(
        and(
          eq(safelinkRules.url, parsed.data.url),
          eq(safelinkRules.pattern, parsed.data.pattern),
        ),
      )
      .limit(1)
  )[0]
  if (existing) {
    await db
      .update(safelinkRules)
      .set({
        action: parsed.data.action,
        reason: parsed.data.reason,
        comment: parsed.data.comment ?? null,
        updatedAt: sql`now()`,
        lastUpdatedBy: actor,
      })
      .where(
        and(
          eq(safelinkRules.url, parsed.data.url),
          eq(safelinkRules.pattern, parsed.data.pattern),
        ),
      )
  } else {
    await pg.insert(safelinkRules).values({
      url: parsed.data.url,
      pattern: parsed.data.pattern,
      action: parsed.data.action,
      reason: parsed.data.reason,
      comment: parsed.data.comment ?? null,
      lastUpdatedBy: actor,
    })
  }
  const eventRow = await pg
    .insert(safelinkEvents)
    .values({
      eventType: existing ? 'updateRule' : 'addRule',
      url: parsed.data.url,
      pattern: parsed.data.pattern,
      action: parsed.data.action,
      reason: parsed.data.reason,
      comment: parsed.data.comment ?? null,
      createdBy: actor,
    })
    .returning({
      id: safelinkEvents.id,
      createdAt: safelinkEvents.createdAt,
    })
  return {
    id: eventRow[0]!.id,
    eventType: existing ? 'updateRule' : 'addRule',
    url: parsed.data.url,
    pattern: parsed.data.pattern,
    action: parsed.data.action,
    reason: parsed.data.reason,
    ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
    createdBy: actor ?? 'admin',
    createdAt: eventRow[0]!.createdAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.safelink.addRule'
