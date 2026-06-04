// XRPC handler: tools.ozone.moderation.getReporterStats
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getReporterStats.json
//
// Per-DID summary: how many reports they've filed, how many were
// resolved (linked to a mod_report_resolution row), and whether the
// reporter is currently muted in mod_muted_reporters.

import { count, eq, inArray, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import {
  modMutedReporters,
  modReportResolution,
  moderationReports,
} from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const dids = parseList(params.dids)
  if (dids.length === 0) {
    throw BadRequest('dids parameter required', 'InvalidRequest')
  }
  if (dids.length > 100) {
    throw BadRequest('at most 100 dids per call', 'InvalidRequest')
  }

  const [totals, resolved, muted] = await Promise.all([
    db
      .select({
        did: moderationReports.reportedByDid,
        n: count(),
      })
      .from(moderationReports)
      .where(inArray(moderationReports.reportedByDid, dids))
      .groupBy(moderationReports.reportedByDid),
    db
      .select({
        did: moderationReports.reportedByDid,
        n: count(),
      })
      .from(moderationReports)
      .innerJoin(
        modReportResolution,
        eq(modReportResolution.reportId, moderationReports.id),
      )
      .where(inArray(moderationReports.reportedByDid, dids))
      .groupBy(moderationReports.reportedByDid),
    db
      .select({ did: modMutedReporters.did })
      .from(modMutedReporters)
      .where(inArray(modMutedReporters.did, dids)),
  ])

  const totalMap = new Map(totals.map((t) => [t.did, Number(t.n)]))
  const resolvedMap = new Map(resolved.map((t) => [t.did, Number(t.n)]))
  const mutedSet = new Set(muted.map((m) => m.did))

  return {
    stats: dids.map((did) => ({
      did,
      reportedCount: totalMap.get(did) ?? 0,
      resolvedCount: resolvedMap.get(did) ?? 0,
      isMuted: mutedSet.has(did),
    })),
  }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

// Suppress unused-import false positive on sql for analyzer.
void sql

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.getReporterStats'
