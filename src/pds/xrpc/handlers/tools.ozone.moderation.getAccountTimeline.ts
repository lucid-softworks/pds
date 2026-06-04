// XRPC handler: tools.ozone.moderation.getAccountTimeline
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getAccountTimeline.json
//
// Chronological log of *every* moderation-related touchpoint for a
// single account: reports filed against them, events emitted against
// them, labels applied. The /mod/subject page already shows a
// curated version; this endpoint exposes the same data through XRPC
// so external Ozone clients can render their own account timeline.
//
// We merge three sources in-memory and sort by createdAt desc:
//   - moderation_reports rows (subject = this DID)
//   - mod_events rows (subject_did = this DID OR subject_uri starts with at://<did>/)
//   - labels rows (uri = this DID OR uri starts with at://<did>/)

import { eq, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { labels, modEvents, moderationReports } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { decode } from '~/pds/codec'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const did = params.account?.trim()
  if (!did || !/^did:/.test(did)) {
    throw BadRequest('account (DID) is required', 'InvalidRequest')
  }
  const limit = parseLimit(params.limit)

  const [reports, events, labelRows] = await Promise.all([
    db
      .select()
      .from(moderationReports)
      .where(eq(moderationReports.subjectDid, did))
      .limit(limit),
    db
      .select()
      .from(modEvents)
      .where(
        sql`${modEvents.subjectDid} = ${did} OR ${modEvents.subjectUri} LIKE ${`at://${did}/%`}`,
      )
      .limit(limit),
    db
      .select()
      .from(labels)
      .where(
        sql`${labels.uri} = ${did} OR ${labels.uri} LIKE ${`at://${did}/%`}`,
      )
      .limit(limit),
  ])

  type Entry = {
    kind: 'report' | 'event' | 'label'
    createdAt: Date
    payload: Record<string, unknown>
  }
  const merged: Entry[] = []
  for (const r of reports) {
    merged.push({
      kind: 'report',
      createdAt: r.createdAt,
      payload: {
        $type: 'tools.ozone.moderation.defs#reportView',
        id: r.id,
        reasonType: r.reasonType,
        reason: r.reason ?? undefined,
        reportedBy: r.reportedByDid,
        subjectDid: r.subjectDid,
        subjectUri: r.subjectUri,
        createdAt: r.createdAt.toISOString(),
      },
    })
  }
  for (const e of events) {
    const snapshot = await decode<Record<string, unknown>>(e.metadata)
    merged.push({
      kind: 'event',
      createdAt: e.createdAt,
      payload: {
        $type: 'tools.ozone.moderation.defs#modEventView',
        id: e.id,
        event: snapshot.event,
        subject: snapshot.subject,
        createdBy: e.createdByDid,
        createdAt: e.createdAt.toISOString(),
      },
    })
  }
  for (const l of labelRows) {
    merged.push({
      kind: 'label',
      createdAt: l.cts,
      payload: {
        src: l.src,
        uri: l.uri,
        ...(l.cid !== null ? { cid: l.cid } : {}),
        val: l.val,
        neg: l.neg,
        cts: l.cts.toISOString(),
      },
    })
  }

  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const page = merged.slice(0, limit)
  return {
    timeline: page.map((m) => ({ kind: m.kind, ...m.payload })),
  }
}

function parseLimit(raw: string | undefined): number {
  const def = 50
  const max = 200
  if (raw === undefined) return def
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > max) {
    throw BadRequest(`limit must be 1..${max}`, 'InvalidRequest')
  }
  return n
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.getAccountTimeline'
