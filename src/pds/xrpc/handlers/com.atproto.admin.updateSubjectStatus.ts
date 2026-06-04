// XRPC handler: com.atproto.admin.updateSubjectStatus
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/updateSubjectStatus.json
//
// Subject-based moderation. Where `updateAccountStatus` operates on
// whole accounts, this dispatches by the subject's `$type`:
//
//   - com.atproto.admin.defs#repoRef      → account-level takedown
//                                          (delegates to the same
//                                          status-flip logic as
//                                          updateAccountStatus)
//   - com.atproto.repo.strongRef          → record-level takedown
//                                          (`records.takedown_ref`)
//   - com.atproto.admin.defs#repoBlobRef  → blob-level takedown
//                                          (`blobs.takedown_ref`)
//
// `takedown.applied` true sets `takedown_ref` to the supplied `ref`
// (defaulting to "1" so the column is non-NULL); false clears it.
// `deactivated` is honoured only for `repoRef` subjects — flips the
// account between `deactivated` and `active`. Anything else returns
// 400 with the reference's exact error message.
//
// Note: chapter 19 already shipped `updateAccountStatus` as the
// account-only moderation surface. This handler is the *subject*-based
// equivalent the upstream lexicon expects; both coexist.

import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts, blobs, records } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { withAdminAudit } from '~/pds/admin/audit'
import { emitAccount } from '~/pds/sequencer/sequence'

const TakedownSchema = z
  .object({
    applied: z.boolean(),
    ref: z.string().optional(),
  })
  .optional()

const RepoRefSchema = z.object({
  $type: z.literal('com.atproto.admin.defs#repoRef'),
  did: z.string().min(1),
})
const StrongRefSchema = z.object({
  $type: z.literal('com.atproto.repo.strongRef'),
  uri: z.string().startsWith('at://'),
  cid: z.string().min(1),
})
const RepoBlobRefSchema = z.object({
  $type: z.literal('com.atproto.admin.defs#repoBlobRef'),
  did: z.string().min(1),
  cid: z.string().min(1),
})

const InputSchema = z.object({
  subject: z.union([RepoRefSchema, StrongRefSchema, RepoBlobRefSchema]),
  takedown: TakedownSchema,
  deactivated: z
    .object({ applied: z.boolean(), ref: z.string().optional() })
    .optional(),
})

const handler: Handler = withAdminAudit(
  {
    action: 'updateSubjectStatus',
    targetDidFrom: (input) => {
      const subject = (input as { subject?: { did?: unknown; uri?: unknown } } | null)
        ?.subject
      if (!subject) return undefined
      if (typeof subject.did === 'string') return subject.did
      // strongRef has a uri shaped at://<did>/<col>/<rkey>
      if (typeof subject.uri === 'string' && subject.uri.startsWith('at://')) {
        const rest = subject.uri.slice('at://'.length)
        const slash = rest.indexOf('/')
        return slash > 0 ? rest.slice(0, slash) : rest
      }
      return undefined
    },
  },
  async ({ input, authorization }) => {
    await requireAdmin(authorization)
    const parsed = InputSchema.safeParse(input)
    if (!parsed.success) {
      throw BadRequest(
        'invalid input: ' +
          parsed.error.issues.map((i) => i.message).join('; '),
      )
    }
    const { subject, takedown, deactivated } = parsed.data

    if (takedown !== undefined) {
      // The lexicon allows ref to be absent on `applied: true`. The
      // reference defaults to a synthetic "1"; we follow suit so the
      // column is always non-NULL when the takedown is in force.
      const ref = takedown.applied ? takedown.ref ?? '1' : null

      if (subject.$type === 'com.atproto.admin.defs#repoRef') {
        const acctRows = await db
          .select({ did: accounts.did })
          .from(accounts)
          .where(eq(accounts.did, subject.did))
          .limit(1)
        if (acctRows.length === 0) {
          throw NotFound(
            `account not found: ${subject.did}`,
            'AccountNotFound',
          )
        }
        await db
          .update(accounts)
          .set({ status: takedown.applied ? 'takendown' : 'active' })
          .where(eq(accounts.did, subject.did))
        await emitAccount(
          takedown.applied
            ? { did: subject.did, active: false, status: 'takendown' }
            : { did: subject.did, active: true },
        )
      } else if (subject.$type === 'com.atproto.repo.strongRef') {
        const { repoDid, collection, rkey } = parseAtUri(subject.uri)
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
      } else {
        await db
          .update(blobs)
          .set({ takedownRef: ref })
          .where(and(eq(blobs.creator, subject.did), eq(blobs.cid, subject.cid)))
      }
    }

    if (deactivated !== undefined) {
      if (subject.$type !== 'com.atproto.admin.defs#repoRef') {
        throw BadRequest(
          'deactivated may only be set on repoRef subjects',
          'InvalidRequest',
        )
      }
      await db
        .update(accounts)
        .set({ status: deactivated.applied ? 'deactivated' : 'active' })
        .where(eq(accounts.did, subject.did))
      await emitAccount(
        deactivated.applied
          ? { did: subject.did, active: false, status: 'deactivated' }
          : { did: subject.did, active: true },
      )
    }

    return {
      subject,
      ...(takedown !== undefined ? { takedown } : {}),
    }
  },
)

function parseAtUri(uri: string): {
  repoDid: string
  collection: string
  rkey: string
} {
  const rest = uri.slice('at://'.length)
  const [did, collection, rkey] = rest.split('/')
  if (!did || !collection || !rkey) {
    throw BadRequest(`invalid AT-URI: ${uri}`, 'InvalidRequest')
  }
  return { repoDid: did, collection, rkey }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.updateSubjectStatus'
