// XRPC handler stub: app.bsky.feed.getActorLikes
//
// Forwards to the AppView. Read-after-write via `getActorLikesMunge`.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub('app.bsky.feed.getActorLikes', 'GET')
export const nsid = stub.nsid
export const def = stub.def
