// XRPC handler registry — one place that knows about every endpoint.
//
// As new handler files land, add them here. The registry is built once at
// import time; the TanStack route imports this module and dispatches.

import { HandlerRegistry } from '../server'
import * as createAccount from './com.atproto.server.createAccount'

export const registry = new HandlerRegistry().register(
  createAccount.nsid,
  createAccount.def,
)
