// XRPC handler: com.atproto.server.createInviteCode
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/createInviteCode.json
//
// Admin-only. Mint one code with N uses, optionally pinned to a recipient
// DID. Used by operators of gated PDSes; ignored when PDS_INVITE_REQUIRED is
// false (the code still works, but signup doesn't require it).
//
// See chapter 12 — Account creation, Invite codes.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAdmin } from '~/pds/auth/middleware'
import { createOneInviteCode } from '~/pds/account/invites'

const InputSchema = z.object({
  useCount: z.number().int().positive().optional(),
  forAccount: z.string().min(1).optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireAdmin(authorization)
  const parsed = InputSchema.safeParse(input ?? {})
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const created = await createOneInviteCode({
    createdBy: null,
    forAccount: parsed.data.forAccount ?? null,
    usesRemaining: parsed.data.useCount ?? 1,
  })
  return { code: created.code }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.createInviteCode'
