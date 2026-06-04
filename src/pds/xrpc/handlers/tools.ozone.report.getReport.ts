// XRPC handler: tools.ozone.report.getReport
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/getReport.json

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { moderationReports } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toReportView } from '~/pds/mod/report'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const id = Number.parseInt(params.id ?? '', 10)
  if (!Number.isFinite(id)) {
    throw BadRequest('id is required', 'InvalidRequest')
  }
  const rows = await db
    .select()
    .from(moderationReports)
    .where(eq(moderationReports.id, id))
    .limit(1)
  if (rows.length === 0) {
    throw NotFound(`report not found: ${id}`, 'ReportNotFound')
  }
  return { report: await toReportView(rows[0]!) }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.report.getReport'
