// XRPC handler: tools.ozone.moderation.cancelScheduledActions
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/cancelScheduledActions.json

import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modScheduledActions } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const ids = parsed.data.ids
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n))
  if (ids.length === 0) {
    throw BadRequest('no valid ids', 'InvalidRequest')
  }
  // Only `pending` rows can be cancelled — a row that's already fired
  // or already cancelled is left alone.
  const updated = await pg
    .update(modScheduledActions)
    .set({ state: 'cancelled' })
    .where(
      and(
        inArray(modScheduledActions.id, ids),
        eq(modScheduledActions.state, 'pending'),
      ),
    )
    .returning({ id: modScheduledActions.id })
  return {
    cancelled: updated.map((r) => String(r.id)),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.moderation.cancelScheduledActions'
