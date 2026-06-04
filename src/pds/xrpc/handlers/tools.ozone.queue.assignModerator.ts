// XRPC handler: tools.ozone.queue.assignModerator
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/assignModerator.json

import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modQueueAssignments, modQueues } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toAssignmentView } from '~/pds/mod/queue'

const InputSchema = z.object({
  queueId: z.number().int(),
  did: z.string().regex(/^did:(plc|web):/),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { queueId, did } = parsed.data

  const queue = await db
    .select()
    .from(modQueues)
    .where(
      and(
        eq(modQueues.id, queueId),
        eq(modQueues.enabled, true),
        isNull(modQueues.deletedAt),
      ),
    )
    .limit(1)
  if (queue.length === 0) {
    throw BadRequest(
      `queue not found or not enabled: ${queueId}`,
      'InvalidAssignment',
    )
  }

  // Close any prior open assignment of this (queue, did) — only one
  // active assignment per pair at a time.
  await db
    .update(modQueueAssignments)
    .set({ endAt: new Date() })
    .where(
      and(
        eq(modQueueAssignments.queueId, queueId),
        eq(modQueueAssignments.did, did),
        isNull(modQueueAssignments.endAt),
      ),
    )

  const inserted = await db
    .insert(modQueueAssignments)
    .values({ queueId, did })
    .returning()
  return toAssignmentView(inserted[0]!, queue[0]!)
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.queue.assignModerator'
