// XRPC handler: tools.ozone.set.deleteSet
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/set/deleteSet.json

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { ozoneSets } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  name: z.string().min(3).max(128),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const existing = await db
    .select({ name: ozoneSets.name })
    .from(ozoneSets)
    .where(eq(ozoneSets.name, parsed.data.name))
    .limit(1)
  if (existing.length === 0) {
    throw NotFound(`set not found: ${parsed.data.name}`, 'SetNotFound')
  }
  // FK cascade on ozone_set_values takes the members with it.
  await db.delete(ozoneSets).where(eq(ozoneSets.name, parsed.data.name))
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.set.deleteSet'
