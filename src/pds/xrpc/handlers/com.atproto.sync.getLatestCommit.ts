// XRPC handler: com.atproto.sync.getLatestCommit
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getLatestCommit.json
//
// Cheap pointer-read for sync clients (AppViews, Relays, backup tools)
// that just want to know "where is this repo right now?" without
// downloading the CAR. Returns the current root CID + rev (TID) of the
// repo's commit log. Compare against your cached rev — if they match
// you're up to date; if not, drive a `getRepo` (full pull) or
// `getBlocks` (delta) to catch up.
//
// No auth required. Status of the repo is reported via the lexicon's
// error names (RepoTakendown / RepoDeactivated / RepoNotFound) so the
// caller can drop or pause sync without inferring it from a generic
// 404. Matches the reference PDS's assertRepoAvailability gate.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts, repos } from '~/lib/db/schema'

const handler: Handler = async ({ params }) => {
  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  const rows = await db
    .select({
      status: accounts.status,
      rootCid: repos.rootCid,
      rev: repos.rev,
    })
    .from(accounts)
    .leftJoin(repos, eq(repos.did, accounts.did))
    .where(eq(accounts.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')

  if (row.status === 'takendown')
    throw NotFound(`repo takendown: ${did}`, 'RepoTakendown')
  if (row.status === 'deactivated')
    throw NotFound(`repo deactivated: ${did}`, 'RepoDeactivated')
  if (row.status === 'deleted')
    throw NotFound(`repo deleted: ${did}`, 'RepoNotFound')

  if (!row.rootCid || !row.rev) {
    // Active account but no commits yet. Sync-wise this is the same as
    // "not found" — there's nothing to fetch.
    throw NotFound(`repo has no commits: ${did}`, 'RepoNotFound')
  }

  return { cid: row.rootCid, rev: row.rev }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getLatestCommit'
