// XRPC handler: tools.ozone.queue.unassignModerator
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/unassignModerator.json

import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modQueueAssignments } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

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

  const updated = await db
    .update(modQueueAssignments)
    .set({ endAt: new Date() })
    .where(
      and(
        eq(modQueueAssignments.queueId, queueId),
        eq(modQueueAssignments.did, did),
        isNull(modQueueAssignments.endAt),
      ),
    )
    .returning()
  if (updated.length === 0) {
    throw BadRequest(
      `no active assignment for queueId=${queueId} did=${did}`,
      'InvalidAssignment',
    )
  }
  return {}
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.queue.unassignModerator'
