// XRPC handler stub: app.bsky.feed.getTimeline
//
// Forwards to the AppView. Read-after-write via `getTimelineMunge`.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub('app.bsky.feed.getTimeline', 'GET')
export const nsid = stub.nsid
export const def = stub.def
