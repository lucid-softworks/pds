// XRPC handler registry — one place that knows about every endpoint.
//
// As new handler files land, add them here. The registry is built once at
// import time; the TanStack route imports this module and dispatches.

import { HandlerRegistry } from '../server'
import * as createAccount from './com.atproto.server.createAccount'
import * as createSession from './com.atproto.server.createSession'
import * as refreshSession from './com.atproto.server.refreshSession'
import * as deleteSession from './com.atproto.server.deleteSession'
import * as getSession from './com.atproto.server.getSession'
import * as describeServer from './com.atproto.server.describeServer'
import * as resolveHandle from './com.atproto.identity.resolveHandle'

export const registry = new HandlerRegistry()
  .register(createAccount.nsid, createAccount.def)
  .register(createSession.nsid, createSession.def)
  .register(refreshSession.nsid, refreshSession.def)
  .register(deleteSession.nsid, deleteSession.def)
  .register(getSession.nsid, getSession.def)
  .register(describeServer.nsid, describeServer.def)
  .register(resolveHandle.nsid, resolveHandle.def)
