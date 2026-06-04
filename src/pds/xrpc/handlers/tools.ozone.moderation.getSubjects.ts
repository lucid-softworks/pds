// XRPC handler: tools.ozone.moderation.getSubjects
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getSubjects.json
//
// Batched mod_subject_status lookup — returns one entry per input
// "subject" (a DID for account-level, an AT-URI for record-level).
// The /mod UI uses this to populate its triage queue without
// per-row round-trips.

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modSubjectStatus } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const subjects = parseList(params.subjects)
  if (subjects.length === 0 || subjects.length > 100) {
    throw BadRequest(
      'subjects must contain 1..100 entries',
      'InvalidRequest',
    )
  }

  // Two queries: one for repoRef subjects (subject_uri IS NULL), one
  // for strongRef subjects (subject_uri IN (...)). Cheaper than the
  // alternative OR-across-shapes.
  const accountDids: string[] = []
  const recordUris: string[] = []
  for (const s of subjects) {
    if (s.startsWith('at://')) recordUris.push(s)
    else if (/^did:/.test(s)) accountDids.push(s)
  }

  const [accountRows, recordRows] = await Promise.all([
    accountDids.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(modSubjectStatus)
          .where(
            and(
              inArray(modSubjectStatus.subjectDid, accountDids),
              isNull(modSubjectStatus.subjectUri),
            ),
          ),
    recordUris.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(modSubjectStatus)
          .where(inArray(modSubjectStatus.subjectUri, recordUris)),
  ])

  const byKey = new Map<string, (typeof accountRows)[number]>()
  for (const r of accountRows) byKey.set(r.subjectDid, r)
  for (const r of recordRows) {
    if (r.subjectUri) byKey.set(r.subjectUri, r)
  }
  void eq

  return {
    subjectStatuses: subjects.map((s) => {
      const r = byKey.get(s)
      if (!r) {
        return s.startsWith('at://')
          ? { subject: { $type: 'com.atproto.repo.strongRef', uri: s, cid: '' } }
          : { subject: { $type: 'com.atproto.admin.defs#repoRef', did: s } }
      }
      return {
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
            ? '#reviewOpen'
            : r.reviewState === 'escalated'
              ? '#reviewEscalated'
              : r.reviewState === 'acknowledged'
                ? '#reviewClosed'
                : '#reviewNone',
        takendown: r.takedownEventId !== null,
        lastReviewedAt: r.lastEventAt.toISOString(),
        ...(r.lastComment !== null ? { comment: r.lastComment } : {}),
        ...(r.tags !== null ? { tags: r.tags } : {}),
        ...(r.priorityScore !== null
          ? { priorityScore: r.priorityScore }
          : {}),
        ...(r.appealState !== null ? { appealState: r.appealState } : {}),
      }
    }),
  }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.getSubjects'
