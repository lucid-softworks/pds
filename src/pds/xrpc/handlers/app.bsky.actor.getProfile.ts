// XRPC handler stub: app.bsky.actor.getProfile
//
// Forwards to the AppView (defaults to api.bsky.app when no
// Atproto-Proxy header). The response is run through the
// `getProfileMunge` read-after-write hook before reaching the
// client — see src/pds/xrpc/proxy.ts and chapter 17.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub('app.bsky.actor.getProfile', 'GET')
export const nsid = stub.nsid
export const def = stub.def
