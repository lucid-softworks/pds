// XRPC handler: tools.ozone.report.getLatestReport
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/getLatestReport.json
//
// Returns the most recently created unresolved report (the moderation
// console uses it to show "you have a new one" at refresh time).

import { desc, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { db } from '~/lib/db'
import { moderationReports, modReportResolution } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toReportView } from '~/pds/mod/report'

const handler: Handler = async ({ authorization }) => {
  await requireModerator(authorization)
  const rows = await db
    .select({ r: moderationReports })
    .from(moderationReports)
    .leftJoin(
      modReportResolution,
      isNull(modReportResolution.reportId),
    )
    .orderBy(desc(moderationReports.createdAt))
    .limit(1)
  if (rows.length === 0) return {}
  return { report: await toReportView(rows[0]!.r) }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.report.getLatestReport'
