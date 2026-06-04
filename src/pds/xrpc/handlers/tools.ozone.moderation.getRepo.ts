// XRPC handler: tools.ozone.moderation.getRepo
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getRepo.json
//
// Moderation-context view of an account. Bundles the basic account
// shape (did, handle, email, status) with the moderation overlay
// (current mod_subject_status, recent events, labels applied to the
// account). One round-trip for the /mod UI and any external Ozone
// client.
//
// The lexicon's `repoViewDetail` includes record/blob inventories
// (`relatedRecords`, `expectedRecords`); we omit those for cost
// reasons (the listing already exists at `repo.listRecords`). The
// view we ship is a compact slice that's enough to render a
// moderator dashboard.
//
// Auth: requireModerator (admin Basic OR moderator JWT).

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import {
  accounts,
  labels,
  modEvents,
  modSubjectStatus,
} from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      emailConfirmedAt: accounts.emailConfirmedAt,
      status: accounts.status,
      invitesDisabled: accounts.invitesDisabled,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const acct = rows[0]
  if (!acct) throw NotFound(`account not found: ${did}`, 'RepoNotFound')

  // Current moderation cache for the account (subject_uri IS NULL).
  const statusRows = await db
    .select()
    .from(modSubjectStatus)
    .where(
      and(
        eq(modSubjectStatus.subjectDid, did),
        isNull(modSubjectStatus.subjectUri),
      ),
    )
    .limit(1)

  // Recent events on the account *and* on records owned by the
  // account. The widen-by-prefix is the same trick queryEvents uses.
  const eventRows = await db
    .select()
    .from(modEvents)
    .where(
      sql`${modEvents.subjectDid} = ${did} OR ${modEvents.subjectUri} LIKE ${`at://${did}/%`}`,
    )
    .orderBy(desc(modEvents.id))
    .limit(25)

  // Labels applied to the account itself (uri = did). Record-level
  // labels are not bundled here — fetch via the public queryLabels
  // surface if needed.
  const labelRows = await db
    .select()
    .from(labels)
    .where(eq(labels.uri, did))
    .orderBy(desc(labels.seq))

  return {
    did: acct.did,
    handle: acct.handle,
    email: acct.email,
    emailConfirmedAt: acct.emailConfirmedAt?.toISOString(),
    indexedAt: acct.createdAt.toISOString(),
    invitesDisabled: acct.invitesDisabled,
    relatedRecords: [],
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
export const nsid = 'tools.ozone.moderation.getRepo'
