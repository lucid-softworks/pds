// XRPC handler: tools.ozone.team.updateMember
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/team/updateMember.json
//
// Currently a no-op beyond auth — our two-role model (lead /
// moderator) doesn't admit role *changes* through this endpoint. The
// lead seat is permanently tied to PDS_MOD_TEAM_HANDLE; everyone
// else is a moderator. We return the current state so callers can
// finish their request flow without errors.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden, NotFound } from '../errors'
import { db } from '~/lib/db'
import { modTeam } from '~/lib/db/schema'
import { listModerators } from '~/pds/mod/team'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  did: z.string().regex(/^did:(plc|web):/),
  role: z.string().optional(),
  disabled: z.boolean().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  if (auth.kind !== 'admin') {
    const team = await listModerators()
    const me = team.find((m) => m.did === auth.did)
    if (!me || me.role !== 'lead') {
      throw Forbidden(
        'only the team lead (or admin) may update moderators',
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
  const row = (
    await db
      .select()
      .from(modTeam)
      .where(eq(modTeam.did, parsed.data.did))
      .limit(1)
  )[0]
  if (!row) throw NotFound(`not on team: ${parsed.data.did}`, 'MemberNotFound')
  // No actual mutation: see the file header. We accept the input shape
  // and echo back current state for client compatibility.
  return {
    did: row.did,
    role:
      row.role === 'lead'
        ? 'tools.ozone.team.defs#roleAdmin'
        : 'tools.ozone.team.defs#roleModerator',
    disabled: false,
    createdAt: row.addedAt.toISOString(),
    lastUpdatedAt: row.addedAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.team.updateMember'
