// XRPC handler stub: app.bsky.notification.registerPush
//
// Forwards to the AppView's notification service (the AppView owns
// the push-token table). POST body carries `serviceDid` + `token` +
// `platform` + `appId`; we pass it through unchanged after minting
// the service-auth JWT.

import { makeBskyAppViewStub } from './_lib/bsky_appview_stub'

const stub = makeBskyAppViewStub(
  'app.bsky.notification.registerPush',
  'POST',
)
export const nsid = stub.nsid
export const def = stub.def
