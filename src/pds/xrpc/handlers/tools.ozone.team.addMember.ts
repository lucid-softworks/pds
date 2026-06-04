// XRPC handler: tools.ozone.team.addMember
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/team/addMember.json
//
// Insert a row into mod_team. Lead-only (or admin Basic). Mirrors the
// /mod/team add form; we share the underlying `addModerator` helper
// so the two surfaces can't drift.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { addModerator } from '~/pds/mod/team'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  did: z.string().regex(/^did:(plc|web):/),
  role: z
    .union([
      z.literal('tools.ozone.team.defs#roleAdmin'),
      z.literal('tools.ozone.team.defs#roleModerator'),
      z.literal('tools.ozone.team.defs#roleTriage'),
    ])
    .optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  // v1 — only the lead (or admin Basic) can mutate the roster.
  if (auth.kind !== 'admin') {
    const { listModerators } = await import('~/pds/mod/team')
    const team = await listModerators()
    const me = team.find((m) => m.did === auth.did)
    if (!me || me.role !== 'lead') {
      throw Forbidden(
        'only the team lead (or admin) may add moderators',
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
  const acct = (
    await db
      .select({ did: accounts.did, status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, parsed.data.did))
      .limit(1)
  )[0]
  if (!acct) throw NotFound(`account not found: ${parsed.data.did}`)
  if (acct.status !== 'active') {
    throw BadRequest(
      `account not active: ${parsed.data.did} (${acct.status})`,
      'InvalidRequest',
    )
  }
  // We collapse the upstream three-role spectrum (admin / moderator /
  // triage) into our two-role lead+moderator schema. AddMember only
  // ever creates a non-lead row; the lead seat is reserved for the
  // PDS_MOD_TEAM_HANDLE account.
  await addModerator({
    did: parsed.data.did,
    role: 'moderator',
    addedBy: auth.kind === 'admin' ? null : auth.did,
  })
  return {
    did: parsed.data.did,
    role: parsed.data.role ?? 'tools.ozone.team.defs#roleModerator',
    disabled: false,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.team.addMember'
