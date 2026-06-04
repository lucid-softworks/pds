// XRPC handler: tools.ozone.verification.grantVerifications
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/verification/grantVerifications.json
//
// For each entry in the input array, creates an
// `app.bsky.graph.verification` record in the *labeler's* repo (the
// team-lead account) that asserts "this DID is verified by us at the
// observed handle / displayName at this point in time." The record
// itself is the canonical declaration; we additionally write a row to
// `verifications_index` so listVerifications can filter by issuer /
// subject without scanning the repo.
//
// Failures per-entry surface in `failedVerifications`; a partial
// success returns both arrays populated.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts, verificationsIndex } from '~/lib/db/schema'
import { applyWrites } from '~/pds/repo/writes'
import { requireModerator } from '~/pds/mod/auth'
import { getModTeamLead } from '~/pds/mod/team'

const VerificationInput = z.object({
  subject: z.string().regex(/^did:(plc|web):/),
  handle: z.string().min(1),
  displayName: z.string().max(128).optional(),
  createdAt: z.string().optional(),
})

const InputSchema = z.object({
  verifications: z.array(VerificationInput).min(1).max(100),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const lead = await getModTeamLead()
  if (!lead) {
    throw BadRequest(
      'labeler not provisioned — create the PDS_MOD_TEAM_HANDLE account first',
      'LabelerNotConfigured',
    )
  }

  const issued: Array<{
    uri: string
    cid: string
    subject: string
    handle: string
    displayName?: string
    createdAt: string
  }> = []
  const failed: Array<{
    subject: string
    error: string
    message: string
  }> = []

  for (const v of parsed.data.verifications) {
    try {
      // Confirm the subject actually exists on this PDS — the verifier
      // is the bookkeeper for accounts they host; verifications for
      // foreign DIDs are out of scope for v1.
      const found = await db
        .select({ did: accounts.did })
        .from(accounts)
        .where(eq(accounts.did, v.subject))
        .limit(1)
      if (found.length === 0) {
        failed.push({
          subject: v.subject,
          error: 'AccountNotFound',
          message: `no account on this PDS for ${v.subject}`,
        })
        continue
      }
      const createdAt = v.createdAt ?? new Date().toISOString()
      const recordValue = {
        $type: 'app.bsky.graph.verification',
        subject: v.subject,
        handle: v.handle,
        ...(v.displayName !== undefined ? { displayName: v.displayName } : {}),
        createdAt,
      }
      const result = await applyWrites({
        did: lead.did,
        writes: [
          {
            action: 'create',
            collection: 'app.bsky.graph.verification',
            value: recordValue,
          },
        ],
      })
      const write = result.writes[0]!
      if (write.action !== 'create' || write.cid === null) {
        failed.push({
          subject: v.subject,
          error: 'InternalError',
          message: 'unexpected write shape',
        })
        continue
      }
      const uri = write.uri
      const cid = write.cid.toString()
      await db
        .insert(verificationsIndex)
        .values({
          uri,
          cid,
          issuerDid: lead.did,
          subjectDid: v.subject,
          handle: v.handle,
          displayName: v.displayName ?? null,
          createdAt: new Date(createdAt),
        })
        .onConflictDoNothing({ target: verificationsIndex.uri })
      issued.push({
        uri,
        cid,
        subject: v.subject,
        handle: v.handle,
        ...(v.displayName !== undefined ? { displayName: v.displayName } : {}),
        createdAt,
      })
    } catch (err) {
      failed.push({
        subject: v.subject,
        error: err instanceof Error ? err.name : 'InternalError',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    verifications: issued,
    failedVerifications: failed,
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.verification.grantVerifications'
