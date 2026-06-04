// XRPC handler: tools.ozone.queue.routeReports
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/routeReports.json
//
// Match each report in `[startReportId, endReportId]` (inclusive) against
// the configured enabled queues by (subjectType, reasonType, collection)
// and write `queue_id` on hit. Returns `assigned` / `unmatched` counters.
//
// Skipped reports: already has a queue_id (we don't overwrite).
// Cap: 5,000-id range per request (lexicon constraint).

import { z } from 'zod'
import { and, between, eq, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { moderationReports } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { findMatchingQueue } from '~/pds/mod/queue'

const InputSchema = z.object({
  startReportId: z.number().int().nonnegative(),
  endReportId: z.number().int().nonnegative(),
})

const MAX_RANGE = 5000

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { startReportId, endReportId } = parsed.data
  if (endReportId < startReportId) {
    throw BadRequest(
      `endReportId must be >= startReportId`,
      'OutOfRange',
    )
  }
  if (endReportId - startReportId >= MAX_RANGE) {
    throw BadRequest(
      `range exceeds ${MAX_RANGE}`,
      'OutOfRange',
    )
  }

  // Only consider reports that haven't been routed yet (queue_id is NULL).
  const rows = await db
    .select()
    .from(moderationReports)
    .where(
      and(
        between(moderationReports.id, startReportId, endReportId),
        isNull(moderationReports.queueId),
      ),
    )

  let assigned = 0
  let unmatched = 0
  for (const report of rows) {
    // subjectType is the lexicon $type discriminator → infer the
    // simplified 'account' | 'record' bucket the queue uses.
    const bucket: 'account' | 'record' =
      report.subjectType === 'com.atproto.admin.defs#repoRef'
        ? 'account'
        : 'record'
    // For record subjects, the collection is the NSID embedded in the
    // AT-URI: at://<did>/<collection>/<rkey>
    let collection: string | null = null
    if (bucket === 'record' && report.subjectUri) {
      const m = report.subjectUri.match(/^at:\/\/[^/]+\/([^/]+)\//)
      if (m) collection = m[1]!
    }
    const queue = await findMatchingQueue({
      subjectType: bucket,
      reasonType: report.reasonType,
      collection,
    })
    if (queue) {
      await db
        .update(moderationReports)
        .set({ queueId: queue.id })
        .where(eq(moderationReports.id, report.id))
      assigned++
    } else {
      unmatched++
    }
  }

  return { assigned, unmatched }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.queue.routeReports'
