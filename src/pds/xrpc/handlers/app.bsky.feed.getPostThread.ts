// XRPC handler stub: app.bsky.feed.getPostThread
//
// Forwards to the AppView. Read-after-write via `getPostThreadMunge`.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub('app.bsky.feed.getPostThread', 'GET')
export const nsid = stub.nsid
export const def = stub.def
