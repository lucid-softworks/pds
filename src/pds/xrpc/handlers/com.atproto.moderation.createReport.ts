// XRPC handler: com.atproto.moderation.createReport
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/moderation/createReport.json
//
// User-facing "Report this account / post / blob" submission. The body
// carries a subject (either a `repoRef` for an account-level report or a
// `strongRef` for a record / blob) and a reason. The PDS itself is *not*
// a moderation authority — in production the report normally flows to
// an upstream mod service (Bluesky's, or whatever the operator points
// at). The PDS's job is to:
//
//   1. Validate the input against the lexicon.
//   2. Persist a row so the operator console has a trail (even when
//      the upstream is unreachable or no upstream is configured).
//   3. Mint a stable `id` and round-trip the lexicon-shaped reply.
//
// Forwarding to an upstream mod service via service-auth is the
// natural next step but isn't wired here yet — bsky.app's expected
// destination (`did:plc:ar7c4by46qjdydhdevvrndac`) would require an
// operator-config knob (PDS_MOD_SERVICE_DID) and a service-auth
// proxy through the existing pds/auth/service_auth.ts helper. See
// chapter 19 — Moderation for the follow-up.

import { z } from 'zod'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { moderationReports } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'

// pglite + postgres-js drivers union erases the `.returning(fields)` overload
// to its no-arg form; narrow to the shared PgDatabase for the typed projection.
const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const REPO_REF_TYPE = 'com.atproto.admin.defs#repoRef'
const STRONG_REF_TYPE = 'com.atproto.repo.strongRef'

// The lexicon defines an open union of reason tokens. We don't enforce a
// closed set: a future Bluesky-defined reason should round-trip without a
// PDS upgrade. We do require a non-empty string and a `com.*` shape.
const ReasonTypeSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9.]*[a-z0-9](#[a-zA-Z0-9-]+)?$/, {
    message: 'reasonType must be a lexicon NSID with optional #fragment',
  })

const RepoRefSchema = z.object({
  $type: z.literal(REPO_REF_TYPE),
  did: z.string().regex(/^did:(plc|web):/, { message: 'did must be did:plc: or did:web:' }),
})

const StrongRefSchema = z.object({
  $type: z.literal(STRONG_REF_TYPE),
  uri: z.string().startsWith('at://'),
  cid: z.string().min(1),
})

const InputSchema = z.object({
  reasonType: ReasonTypeSchema,
  reason: z.string().max(20_000).optional(),
  subject: z.union([RepoRefSchema, StrongRefSchema]),
})

const handler: Handler = async ({ input, authorization }) => {
  const me = await requireAccessAuth(authorization)

  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { reasonType, reason, subject } = parsed.data

  const row =
    subject.$type === REPO_REF_TYPE
      ? {
          reportedByDid: me.did,
          reasonType,
          reason: reason ?? null,
          subjectType: REPO_REF_TYPE,
          subjectDid: subject.did,
          subjectUri: null,
          subjectCid: null,
        }
      : {
          reportedByDid: me.did,
          reasonType,
          reason: reason ?? null,
          subjectType: STRONG_REF_TYPE,
          subjectDid: null,
          subjectUri: subject.uri,
          subjectCid: subject.cid,
        }

  const [stored] = await pg
    .insert(moderationReports)
    .values(row)
    .returning({
      id: moderationReports.id,
      createdAt: moderationReports.createdAt,
    })
  if (!stored) throw BadRequest('failed to persist report', 'InternalError')

  return {
    id: stored.id,
    reasonType,
    ...(reason !== undefined ? { reason } : {}),
    subject:
      subject.$type === REPO_REF_TYPE
        ? { $type: REPO_REF_TYPE, did: subject.did }
        : { $type: STRONG_REF_TYPE, uri: subject.uri, cid: subject.cid },
    reportedBy: me.did,
    createdAt: stored.createdAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.moderation.createReport'
