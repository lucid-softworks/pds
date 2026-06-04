// XRPC handler: tools.ozone.queue.createQueue
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/createQueue.json

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict } from '../errors'
import { db } from '~/lib/db'
import { modQueues } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toQueueView } from '~/pds/mod/queue'

const InputSchema = z.object({
  name: z.string().min(1).max(200),
  subjectTypes: z
    .array(z.enum(['account', 'record', 'message']))
    .min(1),
  collection: z.string().optional(),
  reportTypes: z.array(z.string().min(1)).min(1).max(25),
  description: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { name, subjectTypes, reportTypes, collection, description } = parsed.data

  if (subjectTypes.includes('record') && !collection) {
    throw BadRequest(
      "collection is required when subjectTypes includes 'record'",
      'InvalidRequest',
    )
  }

  try {
    const inserted = await db
      .insert(modQueues)
      .values({
        name,
        description: description ?? null,
        subjectTypes: subjectTypes as string[],
        reportTypes,
        collection: collection ?? null,
        enabled: true,
        createdBy: auth.kind === 'admin' ? 'admin' : auth.did,
      })
      .returning()
    return { queue: await toQueueView(inserted[0]!, false) }
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
export const nsid = 'tools.ozone.queue.createQueue'
