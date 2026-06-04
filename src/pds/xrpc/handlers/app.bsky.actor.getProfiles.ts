// XRPC handler stub: app.bsky.actor.getProfiles
//
// Forwards to the AppView (defaults to api.bsky.app when no
// Atproto-Proxy header). Read-after-write via `getProfilesMunge`.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub('app.bsky.actor.getProfiles', 'GET')
export const nsid = stub.nsid
export const def = stub.def
