// XRPC handler: tools.ozone.server.getConfig
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/server/getConfig.json
//
// "What features is this Ozone surface advertising?" — the moderation
// UI calls this on load to decide which panels to render. The shape is
// fixed; the field set we populate reflects what the bundled PDS+Ozone
// can actually do:
//   - `pds`        — our own publicUrl (always populated; this surface IS the PDS)
//   - `appview`    — the canonical bsky.app AppView (we proxy via Atproto-Proxy)
//   - `blobDivert` — omitted; we don't run a blob-divert quarantine bucket
//   - `chat`       — omitted; chat moderation isn't self-hostable
//   - `viewer`     — the caller's resolved role: admin (Basic) or moderator (Bearer)
//   - `verifierDid` — the team-lead DID (the labeler this PDS hosts)

import type { Handler, HandlerDef } from '../server'
import { getConfig } from '~/lib/config'
import { requireModerator } from '~/pds/mod/auth'
import { getModTeamLead } from '~/pds/mod/team'

const APPVIEW_URL = 'https://api.bsky.app'

const handler: Handler = async ({ request }) => {
  const auth = await requireModerator(request.headers.get('authorization') ?? undefined)
  const cfg = getConfig()
  const lead = await getModTeamLead().catch(() => null)

  return {
    pds: { url: cfg.publicUrl },
    appview: { url: APPVIEW_URL },
    viewer: {
      role:
        auth.kind === 'admin'
          ? 'tools.ozone.team.defs#roleAdmin'
          : 'tools.ozone.team.defs#roleModerator',
    },
    ...(lead ? { verifierDid: lead.did } : {}),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.server.getConfig'
