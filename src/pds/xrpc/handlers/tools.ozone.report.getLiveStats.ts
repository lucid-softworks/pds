// XRPC handler: tools.ozone.report.getLiveStats
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/getLiveStats.json

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireModerator } from '~/pds/mod/auth'
import { computeLiveStats } from '~/pds/mod/report'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  let queueId: number | undefined
  if (params.queueId) {
    const n = Number.parseInt(params.queueId, 10)
    if (!Number.isFinite(n)) {
      throw BadRequest('queueId must be an integer', 'InvalidRequest')
    }
    queueId = n
  }
  const moderatorDid = params.moderatorDid?.trim() || undefined
  const reportTypes = params.reportTypes
    ? (Array.isArray(params.reportTypes)
        ? params.reportTypes
        : params.reportTypes.split(',')
      )
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined

  const stats = await computeLiveStats({ queueId, moderatorDid, reportTypes })
  return {
    ...stats,
    lastUpdated: new Date().toISOString(),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.report.getLiveStats'
