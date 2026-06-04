// XRPC handler: tools.ozone.queue.updateQueue
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/updateQueue.json

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict, NotFound } from '../errors'
import { db } from '~/lib/db'
import { modQueues } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toQueueView } from '~/pds/mod/queue'

const InputSchema = z.object({
  queueId: z.number().int(),
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { queueId, name, enabled, description } = parsed.data

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (name !== undefined) updates.name = name
  if (enabled !== undefined) updates.enabled = enabled
  if (description !== undefined) updates.description = description

  try {
    const updated = await db
      .update(modQueues)
      .set(updates)
      .where(eq(modQueues.id, queueId))
      .returning()
    if (updated.length === 0) {
      throw NotFound(`queue not found: ${queueId}`)
    }
    return { queue: await toQueueView(updated[0]!, false) }
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      /duplicate key|unique constraint/i.test(e.message)
    ) {
      throw Conflict(
        `queue with name "${name}" already exists`,
        'ConflictingQueue',
      )
    }
    throw e
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.queue.updateQueue'
