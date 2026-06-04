// Moderation event sourcing + side effects.
//
// The PDS holds the ground truth for *its own* records and blobs, so when
// a moderator emits a takedown, our handler does double duty:
//
//   1. Append the event to `mod_events` (the audit log Ozone consults).
//   2. Apply the side effect on the source-of-truth column —
//      `records.takedown_ref`, `blobs.takedown_ref`, or
//      `accounts.status` — so the PDS's own read endpoints honour the
//      decision without re-querying the event log.
//   3. Upsert `mod_subject_status` so the next `queryStatuses` call
//      sees the new state without replaying the log.
//
// In real Ozone the side-effect step doesn't exist — Ozone is purely
// the moderation surface and the labels/takedowns it issues flow back
// to the labelled PDS via service-auth calls. Our bundled shape lets
// us skip that hop: we *are* the PDS being moderated.
//
// See chapter 24 — Ozone-shaped moderation.

import { and, eq, sql } from 'drizzle-orm'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { db } from '~/lib/db'
import {
  accounts,
  blobs,
  labels,
  modEvents,
  modReportResolution,
  modSubjectStatus,
  moderationReports,
  records,
} from '~/lib/db/schema'

// pglite + postgres-js drivers union erases the `.returning(fields)`
// overload; narrow to the shared PgDatabase for typed projections.
const pg = db as unknown as PgDatabase<PgQueryResultHKT>
import { encode } from '~/pds/codec'
import { BadRequest, NotFound } from '~/pds/xrpc/errors'
import { emitAccount } from '~/pds/sequencer/sequence'
import { getKeyWrapper } from '~/pds/auth/key_wrap'
import { signBytes } from '~/pds/repo/keys'

const REPO_REF = 'com.atproto.admin.defs#repoRef'
const STRONG_REF = 'com.atproto.repo.strongRef'

// Event types we honour. The lexicon defines 25+ types; we implement
// the operationally meaningful subset and ignore unknown types with a
// clear error (so a v2 client tagging a future type gets feedback
// instead of silent success).
export const SUPPORTED_EVENT_TYPES = [
  'tools.ozone.moderation.defs#modEventTakedown',
  'tools.ozone.moderation.defs#modEventReverseTakedown',
  'tools.ozone.moderation.defs#modEventComment',
  'tools.ozone.moderation.defs#modEventAcknowledge',
  'tools.ozone.moderation.defs#modEventEscalate',
  'tools.ozone.moderation.defs#modEventLabel',
  'tools.ozone.moderation.defs#modEventMute',
  'tools.ozone.moderation.defs#modEventUnmute',
  'tools.ozone.moderation.defs#modEventDivert',
  'tools.ozone.moderation.defs#modEventEmail',
] as const

const RepoRefSchema = z.object({
  $type: z.literal(REPO_REF),
  did: z.string().regex(/^did:(plc|web):/, 'subject DID must be did:plc: or did:web:'),
})
const StrongRefSchema = z.object({
  $type: z.literal(STRONG_REF),
  uri: z.string().startsWith('at://'),
  cid: z.string().min(1),
})

const EventBase = z.object({
  $type: z.string().min(1),
  comment: z.string().optional(),
})
const LabelEvent = EventBase.extend({
  $type: z.literal('tools.ozone.moderation.defs#modEventLabel'),
  createLabelVals: z.array(z.string().min(1)).optional(),
  negateLabelVals: z.array(z.string().min(1)).optional(),
})

export const EmitEventInputSchema = z.object({
  event: EventBase.passthrough(),
  subject: z.union([RepoRefSchema, StrongRefSchema]),
  subjectBlobCids: z.array(z.string().min(1)).optional(),
  createdBy: z.string().regex(/^did:(plc|web):/, 'createdBy must be a DID'),
  externalId: z.string().optional(),
})

export type EmitEventInput = z.infer<typeof EmitEventInputSchema>

export type EmitEventResult = {
  id: number
  eventType: string
  subject: { $type: string; did?: string; uri?: string; cid?: string }
  subjectBlobCids: string[]
  createdBy: string
  createdAt: string
  comment: string | null
}

/** Apply a moderation event. Writes mod_events, mod_subject_status, the
 *  affected takedown columns, and (for label events) the labels table.
 *  Returns the persisted view. */
export async function applyEmitEvent(args: {
  input: EmitEventInput
  labelSrcDid: string | null
}): Promise<EmitEventResult> {
  const { input } = args
  if (
    !(SUPPORTED_EVENT_TYPES as readonly string[]).includes(
      input.event.$type,
    )
  ) {
    throw BadRequest(
      `event type not implemented in this PDS: ${input.event.$type}. ` +
        `Supported: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
      'EventTypeNotSupported',
    )
  }

  const eventType = stripTypePrefix(input.event.$type)
  const comment = typeof input.event.comment === 'string'
    ? input.event.comment
    : null
  const subject = input.subject
  const subjectFlat = subject.$type === REPO_REF
    ? { did: subject.did, uri: null, cid: null }
    : {
        did: parseDidFromAtUri(subject.uri),
        uri: subject.uri,
        cid: subject.cid,
      }
  const subjectBlobCids = input.subjectBlobCids ?? []

  // DAG-CBOR snapshot of the full input so the read endpoints can
  // reconstruct the wire shape. We do this *before* any DB writes so a
  // serialisation failure doesn't leave partial state.
  const metadata = (await encode(input as unknown)).bytes

  // Insert the event row first; downstream rows reference its id.
  const inserted = await pg
    .insert(modEvents)
    .values({
      eventType,
      subjectType: subject.$type,
      subjectDid: subjectFlat.did,
      subjectUri: subjectFlat.uri,
      subjectCid: subjectFlat.cid,
      subjectBlobCids: subjectBlobCids.length > 0 ? subjectBlobCids : null,
      comment,
      metadata,
      createdByDid: input.createdBy,
    })
    .returning({
      id: modEvents.id,
      createdAt: modEvents.createdAt,
    })
  const row = inserted[0]
  if (!row) throw new Error('failed to insert mod_events row')

  // Side effects per event type. Each branch must be idempotent — the
  // same event re-applied (e.g. on a retry) should converge to the same
  // state, not error.
  switch (eventType) {
    case 'modEventTakedown': {
      await applyTakedown(subject, subjectFlat, row.id, subjectBlobCids)
      break
    }
    case 'modEventReverseTakedown': {
      await applyReverseTakedown(subject, subjectFlat, subjectBlobCids)
      break
    }
    case 'modEventAcknowledge':
    case 'modEventEscalate':
    case 'modEventComment':
    case 'modEventMute':
    case 'modEventUnmute':
    case 'modEventDivert': {
      // No external state mutation — these flip the review_state in
      // mod_subject_status, which the upsert below handles.
      break
    }
    case 'modEventLabel': {
      await applyLabel({
        event: input.event,
        subjectFlat,
        labelSrcDid: args.labelSrcDid,
      })
      break
    }
    case 'modEventEmail': {
      // Send an email to the subject account using the existing
      // email backend. Templates from ozone_comm_templates can be
      // pulled by name; the event's `subjectLine` / `content` fields
      // override the template body when set.
      await applyEmailEvent({ event: input.event, subjectFlat })
      break
    }
  }

  await upsertSubjectStatus({
    subjectType: subject.$type,
    subjectFlat,
    eventType,
    eventId: row.id,
    comment,
  })

  // Auto-resolve open reports against the subject when a closing
  // event lands. The three closing actions are takedown,
  // acknowledge, and divert; anything else (comment, escalate, label,
  // email, mute) leaves reports open. The link is idempotent — a
  // second action against the same already-resolved report is a
  // no-op via ON CONFLICT DO NOTHING.
  if (
    eventType === 'modEventTakedown' ||
    eventType === 'modEventAcknowledge' ||
    eventType === 'modEventDivert'
  ) {
    await resolveOpenReports({
      subjectFlat,
      eventId: row.id,
      resolvedBy: input.createdBy,
    })
  }

  return {
    id: row.id,
    eventType: input.event.$type,
    subject:
      subject.$type === REPO_REF
        ? { $type: REPO_REF, did: subject.did }
        : { $type: STRONG_REF, uri: subject.uri, cid: subject.cid },
    subjectBlobCids,
    createdBy: input.createdBy,
    createdAt: row.createdAt.toISOString(),
    comment,
  }
}

async function applyTakedown(
  subject: EmitEventInput['subject'],
  subjectFlat: { did: string; uri: string | null; cid: string | null },
  eventId: number,
  blobCids: string[],
): Promise<void> {
  const ref = String(eventId)
  if (subject.$type === REPO_REF) {
    const acctRows = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, subject.did))
      .limit(1)
    if (acctRows.length === 0) {
      throw NotFound(`account not found: ${subject.did}`, 'SubjectNotFound')
    }
    await db
      .update(accounts)
      .set({ status: 'takendown' })
      .where(eq(accounts.did, subject.did))
    await emitAccount({
      did: subject.did,
      active: false,
      status: 'takendown',
    })
  } else {
    const { repoDid, collection, rkey } = decomposeAtUri(subject.uri)
    await db
      .update(records)
      .set({ takedownRef: ref })
      .where(
        and(
          eq(records.repoDid, repoDid),
          eq(records.collection, collection),
          eq(records.rkey, rkey),
        ),
      )
  }
  if (blobCids.length > 0 && subjectFlat.did) {
    await db
      .update(blobs)
      .set({ takedownRef: ref })
      .where(
        and(
          eq(blobs.creator, subjectFlat.did),
          sql`${blobs.cid} = ANY(${blobCids})`,
        ),
      )
  }
}

async function applyReverseTakedown(
  subject: EmitEventInput['subject'],
  subjectFlat: { did: string; uri: string | null; cid: string | null },
  blobCids: string[],
): Promise<void> {
  if (subject.$type === REPO_REF) {
    const acctRows = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, subject.did))
      .limit(1)
    if (acctRows.length === 0) {
      throw NotFound(`account not found: ${subject.did}`, 'SubjectNotFound')
    }
    // Only flip back to active if currently takendown — never resurrect a
    // deleted account from the moderation surface.
    if (acctRows[0]!.status === 'takendown') {
      await db
        .update(accounts)
        .set({ status: 'active' })
        .where(eq(accounts.did, subject.did))
      await emitAccount({ did: subject.did, active: true })
    }
  } else {
    const { repoDid, collection, rkey } = decomposeAtUri(subject.uri)
    await db
      .update(records)
      .set({ takedownRef: null })
      .where(
        and(
          eq(records.repoDid, repoDid),
          eq(records.collection, collection),
          eq(records.rkey, rkey),
        ),
      )
  }
  if (blobCids.length > 0 && subjectFlat.did) {
    await db
      .update(blobs)
      .set({ takedownRef: null })
      .where(
        and(
          eq(blobs.creator, subjectFlat.did),
          sql`${blobs.cid} = ANY(${blobCids})`,
        ),
      )
  }
}

async function applyEmailEvent(args: {
  event: { $type: string; [k: string]: unknown }
  subjectFlat: { did: string; uri: string | null; cid: string | null }
}): Promise<void> {
  // Email only makes sense for account-level subjects.
  if (!args.subjectFlat.did || args.subjectFlat.uri !== null) {
    throw BadRequest(
      'modEventEmail requires an account subject (repoRef)',
      'InvalidRequest',
    )
  }
  // Resolve the target account's address.
  const targetRows = await db
    .select({ email: accounts.email, status: accounts.status })
    .from(accounts)
    .where(eq(accounts.did, args.subjectFlat.did))
    .limit(1)
  const target = targetRows[0]
  if (!target) {
    throw NotFound(
      `account not found: ${args.subjectFlat.did}`,
      'SubjectNotFound',
    )
  }
  if (target.status === 'deleted') {
    throw BadRequest(
      'cannot email a deleted account',
      'InvalidRequest',
    )
  }

  const subjectLine =
    (args.event.subjectLine as string | undefined) ??
    'A message from your moderation team'
  let body = (args.event.content as string | undefined) ?? ''
  const templateName = args.event.templateName as string | undefined

  // If a template was named and no inline content was supplied, fall
  // back to the template's content_markdown. The lexicon allows either
  // direction; we never overwrite an inline body with the template.
  if (templateName !== undefined && body.length === 0) {
    const { ozoneCommTemplates } = await import('~/lib/db/schema')
    const tpl = (
      await db
        .select()
        .from(ozoneCommTemplates)
        .where(eq(ozoneCommTemplates.name, templateName))
        .limit(1)
    )[0]
    if (!tpl) {
      throw NotFound(
        `communication template not found: ${templateName}`,
        'TemplateNotFound',
      )
    }
    if (tpl.disabled) {
      throw BadRequest(
        `template is disabled: ${templateName}`,
        'TemplateDisabled',
      )
    }
    body = tpl.contentMarkdown
  }

  if (body.length === 0) {
    throw BadRequest(
      'modEventEmail requires content or a non-empty template',
      'InvalidRequest',
    )
  }

  const { getEmailBackend } = await import('~/pds/auth/email_sender')
  await getEmailBackend().send({
    to: target.email,
    subject: subjectLine,
    body,
  })
}

async function applyLabel(args: {
  event: { $type: string; [k: string]: unknown }
  subjectFlat: { did: string; uri: string | null; cid: string | null }
  labelSrcDid: string | null
}): Promise<void> {
  if (!args.labelSrcDid) {
    throw BadRequest(
      'modEventLabel requires a configured mod-team lead; create ' +
        'PDS_MOD_TEAM_HANDLE account first',
      'LabelerNotConfigured',
    )
  }
  const parsed = LabelEvent.safeParse(args.event)
  if (!parsed.success) {
    throw BadRequest(
      'invalid modEventLabel: ' +
        parsed.error.issues.map((i) => i.message).join('; '),
      'InvalidRequest',
    )
  }
  const creates = parsed.data.createLabelVals ?? []
  const negates = parsed.data.negateLabelVals ?? []
  if (creates.length === 0 && negates.length === 0) return

  // Look up the labeler's signing key once. We unwrap the at-rest
  // wrapper just before signing; the plaintext scalar lives only
  // inside this function.
  const signing = await loadLabelerSigningKey(args.labelSrcDid)

  const uri = args.subjectFlat.uri ?? args.subjectFlat.did
  const cid = args.subjectFlat.cid

  for (const val of creates) {
    await insertSignedLabel({
      src: args.labelSrcDid,
      uri,
      cid,
      val,
      neg: false,
      signingKeyPriv: signing,
    })
  }
  for (const val of negates) {
    await insertSignedLabel({
      src: args.labelSrcDid,
      uri,
      cid,
      val,
      neg: true,
      signingKeyPriv: signing,
    })
  }
}

async function loadLabelerSigningKey(did: string): Promise<string> {
  const rows = await db
    .select({ signingKeyPriv: accounts.signingKeyPriv })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  if (rows.length === 0) {
    throw NotFound(
      `labeler account not found: ${did}`,
      'LabelerNotConfigured',
    )
  }
  return getKeyWrapper().unwrap(rows[0]!.signingKeyPriv)
}

async function insertSignedLabel(args: {
  src: string
  uri: string
  cid: string | null
  val: string
  neg: boolean
  signingKeyPriv: string
}): Promise<void> {
  const now = new Date()
  // Canonical unsigned form: only the fields atproto includes in the
  // signed bytes. Matches @atproto/api's signing layout — `cid` omitted
  // when null, no `exp`, no `sig`.
  const unsigned: Record<string, unknown> = {
    src: args.src,
    uri: args.uri,
    val: args.val,
    cts: now.toISOString(),
    neg: args.neg,
  }
  if (args.cid) unsigned.cid = args.cid
  const { bytes } = await encode(unsigned)
  const sig = signBytes(args.signingKeyPriv, bytes)
  await db.insert(labels).values({
    src: args.src,
    uri: args.uri,
    cid: args.cid,
    val: args.val,
    neg: args.neg,
    cts: now,
    sig,
  })
}

async function resolveOpenReports(args: {
  subjectFlat: { did: string; uri: string | null; cid: string | null }
  eventId: number
  resolvedBy: string
}): Promise<void> {
  // Find every report against this subject that doesn't yet have a
  // resolution row, then insert the link in one batch.
  const subjectFilter =
    args.subjectFlat.uri !== null
      ? eq(moderationReports.subjectUri, args.subjectFlat.uri)
      : eq(moderationReports.subjectDid, args.subjectFlat.did)
  const open = await db
    .select({ id: moderationReports.id })
    .from(moderationReports)
    .leftJoin(
      modReportResolution,
      eq(modReportResolution.reportId, moderationReports.id),
    )
    .where(
      and(subjectFilter, sql`${modReportResolution.reportId} IS NULL`),
    )
  if (open.length === 0) return
  await db
    .insert(modReportResolution)
    .values(
      open.map((r) => ({
        reportId: r.id,
        eventId: args.eventId,
        resolvedBy: args.resolvedBy,
      })),
    )
    .onConflictDoNothing({ target: modReportResolution.reportId })
}

async function upsertSubjectStatus(args: {
  subjectType: string
  subjectFlat: { did: string; uri: string | null; cid: string | null }
  eventType: string
  eventId: number
  comment: string | null
}): Promise<void> {
  // Look up existing row first; drizzle's onConflict isn't trivial with
  // our COALESCE-aware index, so we do a manual upsert.
  const where =
    args.subjectFlat.uri !== null
      ? and(
          eq(modSubjectStatus.subjectDid, args.subjectFlat.did),
          eq(modSubjectStatus.subjectUri, args.subjectFlat.uri),
        )
      : and(
          eq(modSubjectStatus.subjectDid, args.subjectFlat.did),
          sql`${modSubjectStatus.subjectUri} IS NULL`,
        )
  const existing = await db
    .select({ id: modSubjectStatus.id })
    .from(modSubjectStatus)
    .where(where)
    .limit(1)

  const takedownEventId =
    args.eventType === 'modEventTakedown' ? args.eventId : null
  const reviewState =
    args.eventType === 'modEventAcknowledge'
      ? 'acknowledged'
      : args.eventType === 'modEventEscalate'
        ? 'escalated'
        : args.eventType === 'modEventMute'
          ? 'muted'
          : args.eventType === 'modEventUnmute'
            ? 'open'
            : args.eventType === 'modEventDivert'
              ? 'diverted'
              : null

  if (existing.length === 0) {
    await db.insert(modSubjectStatus).values({
      subjectType: args.subjectType,
      subjectDid: args.subjectFlat.did,
      subjectUri: args.subjectFlat.uri,
      subjectCid: args.subjectFlat.cid,
      takedownEventId,
      reviewState: reviewState ?? 'open',
      lastComment: args.comment,
      lastEventAt: new Date(),
    })
    return
  }

  // Update only the columns this event type touches; leaves the others
  // intact so a comment-only event doesn't clear an existing takedown.
  const patch: Record<string, unknown> = {
    lastEventAt: new Date(),
  }
  if (args.comment !== null) patch.lastComment = args.comment
  if (args.eventType === 'modEventTakedown') {
    patch.takedownEventId = args.eventId
  }
  if (args.eventType === 'modEventReverseTakedown') {
    patch.takedownEventId = null
  }
  if (reviewState !== null) patch.reviewState = reviewState
  await db.update(modSubjectStatus).set(patch).where(where)
}

function decomposeAtUri(uri: string): {
  repoDid: string
  collection: string
  rkey: string
} {
  if (!uri.startsWith('at://')) {
    throw BadRequest(`invalid AT-URI: ${uri}`, 'InvalidRequest')
  }
  const rest = uri.slice('at://'.length)
  const [did, collection, rkey] = rest.split('/')
  if (!did || !collection || !rkey) {
    throw BadRequest(`invalid AT-URI: ${uri}`, 'InvalidRequest')
  }
  return { repoDid: did, collection, rkey }
}

function parseDidFromAtUri(uri: string): string {
  const { repoDid } = decomposeAtUri(uri)
  return repoDid
}

function stripTypePrefix(fullType: string): string {
  const hashIdx = fullType.indexOf('#')
  return hashIdx >= 0 ? fullType.slice(hashIdx + 1) : fullType
}
