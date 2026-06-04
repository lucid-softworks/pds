// Thin stub handlers for `app.bsky.*` reads that upstream's PDS
// registers as explicit pipethrough handlers.
//
// Most modern bsky.app clients set the `Atproto-Proxy` header, in which
// case the main XRPC dispatcher's generic proxy branch routes the call
// (and runs the per-NSID munges in `READ_AFTER_WRITE_MUNGES`). But the
// upstream PDS also serves these endpoints WITHOUT the header — it
// hard-codes the AppView target. Header-less callers (older clients,
// some bots, scripts) would 404 against our PDS without this stub.
//
// The stub:
//   - Verifies the caller's access JWT.
//   - Hands off to `dispatchViaProxy` with `defaultTarget` set to
//     `did:web:api.bsky.app#bsky_appview`. If the client DID set the
//     header, that one wins; otherwise the default takes effect.
//
// dispatchViaProxy runs the munge at the same place it would for a
// header-carrying call, so read-after-write semantics are preserved.

import type { Handler, HandlerDef } from '../../server'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { dispatchViaProxy } from '../../proxy'

const DEFAULT_APPVIEW = 'did:web:api.bsky.app#bsky_appview'

export function makeBskyAppViewStub(
  nsid: string,
  method: 'GET' | 'POST',
): { nsid: string; def: HandlerDef } {
  const handler: Handler = async ({ request, authorization }) => {
    const account = await requireAccessAuth(authorization)
    return dispatchViaProxy({
      nsid,
      request,
      callerDid: account.did,
      defaultTarget: DEFAULT_APPVIEW,
    })
  }
  return { nsid, def: { method, handler } }
}
