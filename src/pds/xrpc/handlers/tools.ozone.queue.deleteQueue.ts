// XRPC handler: tools.ozone.queue.deleteQueue
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/deleteQueue.json
//
// Soft-delete (sets deleted_at + enabled=false). The lexicon's
// optional `migrateToQueueId` updates all moderation_reports rows
// pointing at the deleted queue to the new target; otherwise we
// NULL the queue_id (the lexicon uses `-1` as a sentinel for
// "unassigned," we model that as NULL).

import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { modQueues, moderationReports } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  queueId: z.number().int(),
  migrateToQueueId: z.number().int().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { queueId, migrateToQueueId } = parsed.data

  if (migrateToQueueId !== undefined && migrateToQueueId === queueId) {
    throw BadRequest(
      'migrateToQueueId cannot equal queueId',
      'InvalidRequest',
    )
  }
  if (migrateToQueueId !== undefined) {
    const target = await db
      .select()
      .from(modQueues)
      .where(and(eq(modQueues.id, migrateToQueueId), isNull(modQueues.deletedAt)))
      .limit(1)
    if (target.length === 0) {
      throw NotFound(`migrate target queue not found: ${migrateToQueueId}`)
    }
  }

  const existing = await db
    .select()
    .from(modQueues)
    .where(and(eq(modQueues.id, queueId), isNull(modQueues.deletedAt)))
    .limit(1)
  if (existing.length === 0) {
    throw NotFound(`queue not found: ${queueId}`)
  }

  let migrated = 0
  if (migrateToQueueId !== undefined) {
    const res = await pg
      .update(moderationReports)
      .set({ queueId: migrateToQueueId })
      .where(eq(moderationReports.queueId, queueId))
      .returning({ id: moderationReports.id })
    migrated = res.length
  } else {
    const res = await pg
      .update(moderationReports)
      .set({ queueId: null })
      .where(eq(moderationReports.queueId, queueId))
      .returning({ id: moderationReports.id })
    migrated = res.length
  }

  await db
    .update(modQueues)
    .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
    .where(eq(modQueues.id, queueId))

  return {
    deleted: true,
    ...(migrateToQueueId !== undefined ? { reportsMigrated: migrated } : {}),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.queue.deleteQueue'
