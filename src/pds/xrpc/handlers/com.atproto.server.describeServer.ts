// XRPC handler: com.atproto.server.describeServer
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/describeServer.json
//
// Unauthenticated server discovery. Clients call this to learn the PDS's
// service DID, the domains it accepts handles under, and policy bits like
// "do new accounts need an invite code?".

import type { Handler, HandlerDef } from '../server'
import { getConfig } from '~/lib/config'

const handler: Handler = async () => {
  const cfg = getConfig()
  // Leading dot is intentional — the lexicon expects suffix form so clients
  // can validate handles by `handle.endsWith(domain)`.
  return {
    did: cfg.serviceDid,
    availableUserDomains: ['.' + cfg.hostname],
    inviteCodeRequired: false,
    phoneVerificationRequired: false,
    links: {},
    contact: {},
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.describeServer'
