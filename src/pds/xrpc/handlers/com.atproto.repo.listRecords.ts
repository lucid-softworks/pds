// XRPC handler: com.atproto.repo.listRecords
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/listRecords.json
//
// Paginate over (collection, rkey) for a single repo. Default order is rkey
// ascending; reverse=true flips it. The cursor is the last rkey of the
// previous page.

import { and, asc, desc, eq, gt, lt } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { records } from '~/lib/db/schema'
import { decode, parseCid } from '~/pds/codec'
import { getBlocks } from '~/pds/repo/blockstore'
import { resolveRepoIdent } from './_lib/resolveRepo'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const handler: Handler = async ({ params }) => {
  const repo = params.repo
  const collection = params.collection
  if (!repo || !collection) {
    throw BadRequest('repo and collection are required', 'InvalidRequest')
  }
  const reverse = params.reverse === 'true'
  const limit = parseLimit(params.limit)
  const cursor = params.cursor

  const did = await resolveRepoIdent(repo)
  const where = [eq(records.repoDid, did), eq(records.collection, collection)]
  if (cursor) {
    where.push(reverse ? lt(records.rkey, cursor) : gt(records.rkey, cursor))
  }

  const rows = await db
    .select({ rkey: records.rkey, cid: records.cid })
    .from(records)
    .where(and(...where))
    .orderBy(reverse ? desc(records.rkey) : asc(records.rkey))
    .limit(limit)

  if (rows.length === 0) {
    return { records: [] }
  }

  // Fetch all the block bytes in one round-trip, then decode.
  const cids = rows.map((r) => parseCid(r.cid))
  const blocks = await getBlocks(did, cids)
  const byCidString = new Map(blocks.map((b) => [b.cid.toString(), b]))

  const out: Array<{ uri: string; cid: string; value: unknown }> = []
  for (const r of rows) {
    const blk = byCidString.get(r.cid)
    if (!blk) continue // skip if the block got GC'd between query + fetch
    const value = await decode<unknown>(blk.bytes, blk.cid)
    out.push({
      uri: `at://${did}/${collection}/${r.rkey}`,
      cid: r.cid,
      value,
    })
  }

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last.rkey : undefined
  return nextCursor ? { records: out, cursor: nextCursor } : { records: out }
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.repo.listRecords'
