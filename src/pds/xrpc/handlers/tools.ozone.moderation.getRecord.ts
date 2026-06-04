// XRPC handler: tools.ozone.moderation.getRecord
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getRecord.json
//
// Moderation-context view of a single record. Bundles the record's
// current row (did, collection, rkey, cid, takedown_ref) with the
// moderation overlay (current mod_subject_status, recent events,
// labels applied to this URI).
//
// This view *does* serve takendown records — moderators need to see
// what they're moderating. The public `repo.getRecord` enforces the
// takedown; this one explicitly doesn't.
//
// Auth: requireModerator.

import { and, desc, eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { labels, modEvents, modSubjectStatus, records } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  const uri = params.uri?.trim()
  if (!uri) throw BadRequest('uri parameter is required', 'InvalidRequest')
  if (!uri.startsWith('at://')) {
    throw BadRequest('uri must start with at://', 'InvalidRequest')
  }
  const rest = uri.slice('at://'.length)
  const [did, collection, rkey] = rest.split('/')
  if (!did || !collection || !rkey) {
    throw BadRequest(`invalid AT-URI: ${uri}`, 'InvalidRequest')
  }

  const rows = await db
    .select({
      cid: records.cid,
      indexedAt: records.indexedAt,
      takedownRef: records.takedownRef,
    })
    .from(records)
    .where(
      and(
        eq(records.repoDid, did),
        eq(records.collection, collection),
        eq(records.rkey, rkey),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`record not found: ${uri}`, 'RecordNotFound')

  const statusRows = await db
    .select()
    .from(modSubjectStatus)
    .where(eq(modSubjectStatus.subjectUri, uri))
    .limit(1)

  const eventRows = await db
    .select()
    .from(modEvents)
    .where(eq(modEvents.subjectUri, uri))
    .orderBy(desc(modEvents.id))
    .limit(25)

  const labelRows = await db
    .select()
    .from(labels)
    .where(eq(labels.uri, uri))
    .orderBy(desc(labels.seq))

  return {
    uri,
    cid: row.cid,
    indexedAt: row.indexedAt.toISOString(),
    takendown: row.takedownRef !== null,
    moderation: {
      subjectStatus: statusRows[0]
        ? {
            id: statusRows[0].id,
            reviewState: reviewStateRef(statusRows[0].reviewState),
            takendown: statusRows[0].takedownEventId !== null,
            lastReviewedAt: statusRows[0].lastEventAt.toISOString(),
            ...(statusRows[0].lastComment
              ? { comment: statusRows[0].lastComment }
              : {}),
          }
        : null,
      events: eventRows.map(eventViewRow),
      labels: labelRows.map(labelViewRow),
    },
  }
}

function reviewStateRef(state: string): string {
  if (state === 'escalated') return '#reviewEscalated'
  if (state === 'acknowledged') return '#reviewClosed'
  if (state === 'closed') return '#reviewNone'
  return '#reviewOpen'
}

function eventViewRow(row: typeof modEvents.$inferSelect) {
  return {
    id: row.id,
    eventType: row.eventType,
    subjectDid: row.subjectDid,
    subjectUri: row.subjectUri,
    subjectCid: row.subjectCid,
    comment: row.comment,
    createdBy: row.createdByDid,
    createdAt: row.createdAt.toISOString(),
  }
}

function labelViewRow(row: typeof labels.$inferSelect) {
  return {
    src: row.src,
    uri: row.uri,
    ...(row.cid !== null ? { cid: row.cid } : {}),
    val: row.val,
    neg: row.neg,
    cts: row.cts.toISOString(),
    ...(row.exp !== null ? { exp: row.exp.toISOString() } : {}),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.getRecord'
