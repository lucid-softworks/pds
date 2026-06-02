// XRPC handler: com.atproto.server.createInviteCodes
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/createInviteCodes.json
//
// Admin-only bulk mint. If `forAccounts` is empty (or omitted), `codeCount`
// codes are minted unpinned. If `forAccounts` is non-empty, `codeCount` codes
// are minted *per listed account*. The response is grouped by recipient so
// the operator can hand each batch to the right user.
//
// See chapter 12 — Account creation, Invite codes.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAdmin } from '~/pds/auth/middleware'
import { createOneInviteCode } from '~/pds/account/invites'

const InputSchema = z.object({
  codeCount: z.number().int().positive(),
  useCount: z.number().int().positive().optional(),
  forAccounts: z.array(z.string().min(1)).optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireAdmin(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const usesRemaining = parsed.data.useCount ?? 1
  // Empty array and missing field both mean "unattributed bulk mint" — we
  // synthesise a single null entry so the loop below mints `codeCount` codes
  // exactly once. This matches the upstream lexicon's response shape: each
  // account string appears as a group, and the null case becomes a single
  // group keyed by the empty string.
  const accounts =
    parsed.data.forAccounts && parsed.data.forAccounts.length > 0
      ? parsed.data.forAccounts
      : [null]
  const codes: Array<{ account: string; codes: string[] }> = []
  for (const account of accounts) {
    const batch: string[] = []
    for (let i = 0; i < parsed.data.codeCount; i++) {
      const created = await createOneInviteCode({
        createdBy: null,
        forAccount: account,
        usesRemaining,
      })
      batch.push(created.code)
    }
    codes.push({ account: account ?? '', codes: batch })
  }
  return { codes }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.createInviteCodes'
