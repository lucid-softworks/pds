// XRPC handler: tools.ozone.set.deleteValues
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/set/deleteValues.json

import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { ozoneSetValues, ozoneSets } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  name: z.string().min(3).max(128),
  values: z.array(z.string().min(1)).min(1).max(1000),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const setRow = (
    await db
      .select({ name: ozoneSets.name })
      .from(ozoneSets)
      .where(eq(ozoneSets.name, parsed.data.name))
      .limit(1)
  )[0]
  if (!setRow) {
    throw NotFound(`set not found: ${parsed.data.name}`, 'SetNotFound')
  }
  await db
    .delete(ozoneSetValues)
    .where(
      and(
        eq(ozoneSetValues.setName, parsed.data.name),
        inArray(ozoneSetValues.value, parsed.data.values),
      ),
    )
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.set.deleteValues'
