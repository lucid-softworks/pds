// XRPC handler: com.atproto.server.listAppPasswords
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/listAppPasswords.json
//
// Enumerate the calling account's app passwords. We only return metadata
// (name, createdAt, privileged) — the plaintext is not recoverable.
//
// See chapter 13 — Authentication.

import type { Handler, HandlerDef } from '../server'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { listAppPasswords } from '~/pds/auth/app_password'

const handler: Handler = async ({ authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  const rows = await listAppPasswords(me.did)
  return {
    passwords: rows.map((r) => ({
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      privileged: r.privileged,
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.listAppPasswords'
