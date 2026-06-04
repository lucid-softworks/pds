// XRPC handler stub: app.bsky.feed.getFeed
//
// Forwards to the AppView. No read-after-write munge — custom feeds
// run entirely on the AppView (the feed generator's algorithm),
// nothing local to merge.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub('app.bsky.feed.getFeed', 'GET')
export const nsid = stub.nsid
export const def = stub.def
