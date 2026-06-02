// XRPC handler: com.atproto.repo.getRecord
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/getRecord.json
//
// Read a single record. The records table holds the current (collection, rkey)
// → CID mapping; the bytes live in repo_blocks. No auth — repos are public.

import { and, eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { records } from '~/lib/db/schema'
import { decode, parseCid } from '~/pds/codec'
import { getBlock } from '~/pds/repo/blockstore'
import { resolveRepoIdent } from './_lib/resolveRepo'

const handler: Handler = async ({ params }) => {
  const repo = params.repo
  const collection = params.collection
  const rkey = params.rkey
  const pinnedCid = params.cid
  if (!repo || !collection || !rkey) {
    throw BadRequest(
      'repo, collection, and rkey are required',
      'InvalidRequest',
    )
  }

  const did = await resolveRepoIdent(repo)
  const rows = await db
    .select({ cid: records.cid })
    .from(records)
    .where(
      and(
        eq(records.repoDid, did),
        eq(records.collection, collection),
        eq(records.rkey, rkey),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw NotFound(`record not found: ${repo}/${collection}/${rkey}`, 'RecordNotFound')
  }
  if (pinnedCid && pinnedCid !== row.cid) {
    // Current record exists but isn't at the requested version. Treat as
    // not-found per the lexicon — we don't keep historical record bytes
    // around (block GC may have pruned them already).
    throw NotFound(
      `record not found at requested CID: ${pinnedCid}`,
      'RecordNotFound',
    )
  }

  const cid = parseCid(row.cid)
  const block = await getBlock(did, cid)
  if (!block) {
    throw NotFound(
      `record block missing: ${row.cid}`,
      'RecordNotFound',
    )
  }
  const value = await decode<unknown>(block.bytes, cid)
  return {
    uri: `at://${did}/${collection}/${rkey}`,
    cid: row.cid,
    value,
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.repo.getRecord'
