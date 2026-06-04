// XRPC handler: tools.ozone.team.deleteMember
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/team/deleteMember.json

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden, NotFound } from '../errors'
import { listModerators, removeModerator } from '~/pds/mod/team'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  did: z.string().regex(/^did:(plc|web):/),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  if (auth.kind !== 'admin') {
    const team = await listModerators()
    const me = team.find((m) => m.did === auth.did)
    if (!me || me.role !== 'lead') {
      throw Forbidden(
        'only the team lead (or admin) may remove moderators',
        'NotALead',
      )
    }
  }
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const ok = await removeModerator(parsed.data.did)
  if (!ok) {
    throw NotFound(
      `cannot remove ${parsed.data.did} (lead seat, or not on team)`,
      'MemberNotFound',
    )
  }
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.team.deleteMember'
