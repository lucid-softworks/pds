// XRPC handler: tools.ozone.set.upsertSet
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/set/upsertSet.json

import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { ozoneSets } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[A-Za-z0-9_\-.]+$/),
  description: z.string().max(1024).optional(),
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
    .select({ name: ozoneSets.name, createdAt: ozoneSets.createdAt })
    .from(ozoneSets)
    .where(eq(ozoneSets.name, parsed.data.name))
    .limit(1)
  if (existing.length === 0) {
    await pg.insert(ozoneSets).values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    })
  } else {
    await db
      .update(ozoneSets)
      .set({
        description: parsed.data.description ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(ozoneSets.name, parsed.data.name))
  }
  return {
    name: parsed.data.name,
    ...(parsed.data.description !== undefined
      ? { description: parsed.data.description }
      : {}),
    createdAt: (existing[0]?.createdAt ?? new Date()).toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.set.upsertSet'
