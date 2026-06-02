// XRPC handler: com.atproto.server.getAccountInviteCodes
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/getAccountInviteCodes.json
//
// Return every code the authenticated account has minted, including the
// audit log of who's redeemed each. Personal-quota auto-minting (the upstream
// behaviour where every active account gets a small quota refreshed over
// time) is a follow-up: right now this list will be empty unless the user
// also has admin rights and minted codes that way.
//
// See chapter 12 — Account creation, Invite codes.

import type { Handler, HandlerDef } from '../server'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { listInviteCodesForAccount } from '~/pds/account/invites'

const handler: Handler = async ({ authorization }) => {
  const me = await requireAccessAuth(authorization)
  const rows = await listInviteCodesForAccount(me.did)
  return {
    codes: rows.map((r) => ({
      code: r.code,
      available: r.usesRemaining,
      disabled: r.disabled,
      forAccount: r.forAccount ?? '',
      createdBy: me.did,
      createdAt: r.createdAt.toISOString(),
      uses: r.uses.map((u) => ({
        usedBy: u.usedBy,
        usedAt: u.usedAt.toISOString(),
      })),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.getAccountInviteCodes'
