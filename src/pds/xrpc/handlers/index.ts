// XRPC handler registry — one place that knows about every endpoint.
//
// As new handler files land, add them here. The registry is built once at
// import time; the TanStack route imports this module and dispatches.

import { HandlerRegistry } from '../server'

// server / account / session
import * as createAccount from './com.atproto.server.createAccount'
import * as createSession from './com.atproto.server.createSession'
import * as refreshSession from './com.atproto.server.refreshSession'
import * as deleteSession from './com.atproto.server.deleteSession'
import * as getSession from './com.atproto.server.getSession'
import * as describeServer from './com.atproto.server.describeServer'
// identity
import * as resolveHandle from './com.atproto.identity.resolveHandle'
// repo
import * as createRecord from './com.atproto.repo.createRecord'
import * as putRecord from './com.atproto.repo.putRecord'
import * as deleteRecord from './com.atproto.repo.deleteRecord'
import * as getRecord from './com.atproto.repo.getRecord'
import * as listRecords from './com.atproto.repo.listRecords'
import * as applyWrites from './com.atproto.repo.applyWrites'
import * as describeRepo from './com.atproto.repo.describeRepo'
import * as uploadBlob from './com.atproto.repo.uploadBlob'
// sync
import * as getBlob from './com.atproto.sync.getBlob'
import * as getBlocks from './com.atproto.sync.getBlocks'
import * as getLatestCommit from './com.atproto.sync.getLatestCommit'
import * as syncGetRecord from './com.atproto.sync.getRecord'
import * as getRepo from './com.atproto.sync.getRepo'
import * as getRepoStatus from './com.atproto.sync.getRepoStatus'
import * as listRepos from './com.atproto.sync.listRepos'

export const registry = new HandlerRegistry()
  .register(createAccount.nsid, createAccount.def)
  .register(createSession.nsid, createSession.def)
  .register(refreshSession.nsid, refreshSession.def)
  .register(deleteSession.nsid, deleteSession.def)
  .register(getSession.nsid, getSession.def)
  .register(describeServer.nsid, describeServer.def)
  .register(resolveHandle.nsid, resolveHandle.def)
  .register(createRecord.nsid, createRecord.def)
  .register(putRecord.nsid, putRecord.def)
  .register(deleteRecord.nsid, deleteRecord.def)
  .register(getRecord.nsid, getRecord.def)
  .register(listRecords.nsid, listRecords.def)
  .register(applyWrites.nsid, applyWrites.def)
  .register(describeRepo.nsid, describeRepo.def)
  .register(uploadBlob.nsid, uploadBlob.def)
  .register(getBlob.nsid, getBlob.def)
  .register(getBlocks.nsid, getBlocks.def)
  .register(getLatestCommit.nsid, getLatestCommit.def)
  .register(syncGetRecord.nsid, syncGetRecord.def)
  .register(getRepo.nsid, getRepo.def)
  .register(getRepoStatus.nsid, getRepoStatus.def)
  .register(listRepos.nsid, listRepos.def)
