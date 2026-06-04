// XRPC handler: tools.ozone.report.unassignModerator
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/unassignModerator.json

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { moderationReports } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  reportId: z.number().int(),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { reportId } = parsed.data

  const updated = await pg
    .update(moderationReports)
    .set({ assignedToDid: null, assignedAt: null })
    .where(eq(moderationReports.id, reportId))
    .returning({ id: moderationReports.id })
  if (updated.length === 0) {
    throw NotFound(`report not found: ${reportId}`, 'ReportNotFound')
  }
  return {}
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.report.unassignModerator'
