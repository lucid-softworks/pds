// XRPC handler: tools.ozone.moderation.queryStatuses
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/queryStatuses.json
//
// Read of the `mod_subject_status` cache — every subject that has ever
// been actioned, with current review state + takedown pointer. Filters
// in scope for v1:
//
//   - subject         a DID (account) or AT-URI (record)
//   - takedown        true  → only subjects currently taken down
//                     false → only subjects NOT currently taken down
//                             (still in the cache because some other
//                              action ran)
//   - reviewState     'open' | 'escalated' | 'acknowledged' | 'closed'
//   - limit           1..100 (default 50)
//   - cursor          opaque (last-row id of the previous page)
//
// Deferred filters (chapter 24): includeAllUserRecords, collections,
// reportedAfter / reportedBefore, hostingDeletedAfter, takendown alone
// (we conflate with takedown), reviewedAfter / reviewedBefore, etc.

import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modSubjectStatus } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const parsed = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw BadRequest(
        `limit must be between 1 and ${MAX_LIMIT}`,
        'InvalidRequest',
      )
    }
    limit = parsed
  }

  let cursorId: number | undefined
  if (params.cursor !== undefined) {
    const n = Number.parseInt(params.cursor, 10)
    if (!Number.isFinite(n) || n < 0) {
      throw BadRequest('invalid cursor', 'InvalidRequest')
    }
    cursorId = n
  }

  const subject = params.subject?.trim()
  let subjectCondition
  if (subject) {
    if (subject.startsWith('at://')) {
      subjectCondition = eq(modSubjectStatus.subjectUri, subject)
    } else if (/^did:/.test(subject)) {
      // Same widen-by-prefix trick as queryEvents.
      subjectCondition = or(
        and(
          eq(modSubjectStatus.subjectDid, subject),
          isNull(modSubjectStatus.subjectUri),
        ),
        sql`${modSubjectStatus.subjectUri} LIKE ${`at://${subject}/%`}`,
      )
    } else {
      throw BadRequest(
        'subject must be a DID or an AT-URI starting with at://',
        'InvalidRequest',
      )
    }
  }

  const reviewState = params.reviewState?.trim()
  if (
    reviewState !== undefined &&
    reviewState !== 'open' &&
    reviewState !== 'escalated' &&
    reviewState !== 'acknowledged' &&
    reviewState !== 'closed'
  ) {
    throw BadRequest(
      'reviewState must be open, escalated, acknowledged, or closed',
      'InvalidRequest',
    )
  }

  let takedown: boolean | undefined
  if (params.takedown !== undefined) {
    if (params.takedown === 'true') takedown = true
    else if (params.takedown === 'false') takedown = false
    else throw BadRequest('takedown must be "true" or "false"', 'InvalidRequest')
  }

  const whereClause = and(
    subjectCondition,
    reviewState ? eq(modSubjectStatus.reviewState, reviewState) : undefined,
    takedown === true
      ? isNotNull(modSubjectStatus.takedownEventId)
      : undefined,
    takedown === false
      ? isNull(modSubjectStatus.takedownEventId)
      : undefined,
    cursorId !== undefined ? lt(modSubjectStatus.id, cursorId) : undefined,
  )

  const rows = await db
    .select()
    .from(modSubjectStatus)
    .where(whereClause)
    .orderBy(desc(modSubjectStatus.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    subjectStatuses: page.map((r) => ({
      id: r.id,
      subject:
        r.subjectUri !== null
          ? {
              $type: 'com.atproto.repo.strongRef',
              uri: r.subjectUri,
              cid: r.subjectCid ?? '',
            }
          : { $type: 'com.atproto.admin.defs#repoRef', did: r.subjectDid },
      reviewState:
        r.reviewState === 'open'
          ? 'tools.ozone.moderation.defs#reviewOpen'
          : r.reviewState === 'escalated'
            ? 'tools.ozone.moderation.defs#reviewEscalated'
            : r.reviewState === 'acknowledged'
              ? 'tools.ozone.moderation.defs#reviewClosed'
              : 'tools.ozone.moderation.defs#reviewNone',
      takendown: r.takedownEventId !== null,
      // Per the upstream subjectStatusView shape (chapter 24 cross-check):
      //   createdAt   — first moderation event on this subject
      //   updatedAt   — most recent event (was emitted as `lastReviewedAt`)
      //   tags / priorityScore / appeal — set by their respective events
      // We keep `lastReviewedAt` for backwards compat with the older shape.
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.lastEventAt.toISOString(),
      lastReviewedAt: r.lastEventAt.toISOString(),
      ...(r.lastComment !== null ? { comment: r.lastComment } : {}),
      ...(r.tags !== null && r.tags.length > 0 ? { tags: r.tags } : {}),
      ...(r.priorityScore !== null
        ? { priorityScore: r.priorityScore }
        : {}),
      ...(r.appealState !== null ? { appealed: r.appealState === 'resolved' } : {}),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.queryStatuses'
