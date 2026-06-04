// XRPC handler: tools.ozone.verification.revokeVerifications
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/verification/revokeVerifications.json
//
// For each AT-URI in the input, deletes the verification record from
// the labeler's repo and removes the matching row in
// `verifications_index`. Returns per-URI success / failure arrays.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { verificationsIndex } from '~/lib/db/schema'
import { applyWrites } from '~/pds/repo/writes'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  uris: z.array(z.string().startsWith('at://')).min(1).max(100),
  revokeReason: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }

  const revoked: string[] = []
  const failed: Array<{ uri: string; error: string; message: string }> = []

  for (const uri of parsed.data.uris) {
    try {
      const row = (
        await db
          .select()
          .from(verificationsIndex)
          .where(eq(verificationsIndex.uri, uri))
          .limit(1)
      )[0]
      if (!row) {
        failed.push({
          uri,
          error: 'VerificationNotFound',
          message: 'no verification record for that uri on this labeler',
        })
        continue
      }
      const { repoDid, collection, rkey } = parseAtUri(uri)
      if (repoDid !== row.issuerDid) {
        failed.push({
          uri,
          error: 'IssuerMismatch',
          message: 'index issuer does not match uri repo',
        })
        continue
      }
      await applyWrites({
        did: row.issuerDid,
        writes: [{ action: 'delete', collection, rkey }],
      })
      await db
        .delete(verificationsIndex)
        .where(eq(verificationsIndex.uri, uri))
      revoked.push(uri)
    } catch (err) {
      failed.push({
        uri,
        error: err instanceof Error ? err.name : 'InternalError',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { revokedVerifications: revoked, failedRevocations: failed }
}

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
export const nsid = 'tools.ozone.verification.revokeVerifications'
