// XRPC handler: com.atproto.sync.listBlobs
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/listBlobs.json
//
// Paginated enumeration of every blob CID belonging to a repo. Used by
// sync clients building a backup, by an AppView checking blob coverage
// for a new actor, and by the destination of a migration *before*
// `repo.listMissingBlobs` narrows the set (you can also call this
// against the source PDS to inventory everything Alice has, regardless
// of what survived `importRepo`).
//
// No auth required. Same status-name discipline as `getLatestCommit`
// — takedown / deactivated / deleted accounts surface as the matching
// lexicon error so a consumer can drop or pause sync without parsing a
// generic 404.

import { and, asc, eq, gt, gte } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts, blobs } from '~/lib/db/schema'

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 500

const handler: Handler = async ({ params }) => {
  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  // Status gate. Mirrors getLatestCommit so callers see consistent
  // error names across the sync surface.
  const acctRows = await db
    .select({ status: accounts.status })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const acct = acctRows[0]
  if (!acct) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')
  if (acct.status === 'takendown')
    throw NotFound(`repo takendown: ${did}`, 'RepoTakendown')
  if (acct.status === 'deactivated')
    throw NotFound(`repo deactivated: ${did}`, 'RepoDeactivated')
  if (acct.status === 'deleted')
    throw NotFound(`repo deleted: ${did}`, 'RepoNotFound')

  // Limit + cursor parsing. cursor is the last blob CID from the prior
  // page; we order by cid asc so a string `>` comparison gives the next
  // window cleanly.
  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const parsed = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw BadRequest(
        `limit must be between 1 and ${MAX_LIMIT}`,
        'InvalidRequest',
      )
    }
    limit = parsed
  }
  const cursor = params.cursor?.trim()

  // `since` is a rev (TID) — "blobs uploaded at or after this commit
  // revision." We don't track rev-on-blob today; the column doesn't
  // exist, so the closest honest behaviour is to reject the param
  // rather than silently ignore it (which a syncing client might mis-
  // read as "no new blobs since rev X"). Future: add `since_rev` to
  // blobs on insert and switch to a `gte(blobs.sinceRev, since)`
  // condition.
  if (params.since !== undefined) {
    throw BadRequest(
      'since filter not implemented yet — drop the parameter to list all blobs',
      'InvalidRequest',
    )
  }

  const rows = await db
    .select({ cid: blobs.cid })
    .from(blobs)
    .where(
      and(
        eq(blobs.creator, did),
        cursor ? gt(blobs.cid, cursor) : undefined,
        params.since ? gte(blobs.createdAt, new Date(params.since)) : undefined,
      ),
    )
    .orderBy(asc(blobs.cid))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.cid
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    cids: page.map((r) => r.cid),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.listBlobs'
