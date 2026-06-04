// XRPC handler: tools.ozone.moderation.emitEvent
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/emitEvent.json
//
// The hot path of the Ozone-shape: take a moderation decision and
// commit it. Implemented event types in v1:
//
//   - modEventTakedown / modEventReverseTakedown   (state mutation)
//   - modEventComment / modEventAcknowledge        (record-only)
//   - modEventEscalate
//   - modEventLabel                                 (issues signed labels)
//
// Anything else returns BadRequest with `EventTypeNotSupported` so a
// future Bluesky-defined event type doesn't silently no-op against
// this PDS.
//
// Auth: admin Basic OR access JWT whose subject DID is in `mod_team`.
// `createdBy` must equal the auth'd DID when a moderator is calling;
// admin Basic may supply any DID.
//
// See chapter 24 — Ozone-shaped moderation.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireModerator } from '~/pds/mod/auth'
import { getModTeamLead } from '~/pds/mod/team'
import { applyEmitEvent, EmitEventInputSchema } from '~/pds/mod/events'

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)

  const parsed = EmitEventInputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }

  // Moderator-DID auth: createdBy must equal the auth'd DID (else a
  // moderator could impersonate the team lead in the audit log).
  // Admin Basic bypasses this — operators may attribute events to any
  // DID, which is what makes "admin can do anything" work.
  if (auth.kind === 'moderator' && parsed.data.createdBy !== auth.did) {
    throw BadRequest(
      `createdBy must equal the authenticated moderator DID (${auth.did})`,
      'InvalidRequest',
    )
  }

  const lead = await getModTeamLead()
  const result = await applyEmitEvent({
    input: parsed.data,
    labelSrcDid: lead?.did ?? null,
  })

  return result
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.moderation.emitEvent'
