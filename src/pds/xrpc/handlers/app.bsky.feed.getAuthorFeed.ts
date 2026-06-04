// XRPC handler stub: app.bsky.feed.getAuthorFeed
//
// Forwards to the AppView. Read-after-write via `getAuthorFeedMunge`.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub('app.bsky.feed.getAuthorFeed', 'GET')
export const nsid = stub.nsid
export const def = stub.def
