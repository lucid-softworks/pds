// XRPC handler: com.atproto.sync.getRecord
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getRecord.json
//
// Returns the commit + MST nodes on the path to a single record + the record
// itself, as a CAR. This is a Merkle proof: the consumer can verify the
// record's CID is reachable from the signed commit without holding the
// rest of the repo.
//
// Returns a Response (binary); dispatcher must passthrough.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { repos } from '~/lib/db/schema'
import { parseCid } from '~/pds/codec'
import { encodeCar, type CarBlock } from '~/pds/car/encode'
import { getBlock } from '~/pds/repo/blockstore'
import { collectRecordProofCids } from '~/pds/repo/sync'

const handler: Handler = async ({ params }) => {
  const did = params.did?.trim()
  const collection = params.collection?.trim()
  const rkey = params.rkey?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')
  if (!collection) {
    throw BadRequest('collection parameter is required', 'InvalidRequest')
  }
  if (!rkey) throw BadRequest('rkey parameter is required', 'InvalidRequest')

  const rows = await db
    .select({ rootCid: repos.rootCid })
    .from(repos)
    .where(eq(repos.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')

  // The optional `commit` param lets a caller pin a historical commit. We
  // accept it but verify it matches the head — historical commit retrieval
  // is a follow-up.
  const head = parseCid(row.rootCid)
  if (params.commit) {
    const requested = parseCid(params.commit)
    if (requested.toString() !== head.toString()) {
      throw NotFound(
        'historical commits are not retained on this PDS',
        'CommitNotFound',
      )
    }
  }

  const recordKey = `${collection}/${rkey}`
  const { cids, valueCid } = await collectRecordProofCids(did, head, recordKey)
  if (!valueCid) {
    throw NotFound(`record not found: ${recordKey}`, 'RecordNotFound')
  }

  const blocks: CarBlock[] = []
  for (const cid of cids) {
    const b = await getBlock(did, cid)
    if (!b) throw new Error(`block disappeared: ${cid}`)
    blocks.push({ cid: b.cid, bytes: b.bytes })
  }

  const car = await encodeCar({ roots: [head], blocks })
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(car)
        controller.close()
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/vnd.ipld.car',
        'cache-control': 'no-store',
      },
    },
  )
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getRecord'
