// XRPC handler: com.atproto.sync.getRepo
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getRepo.json
//
// Returns the full repository as a CAR. The response is binary; we build a
// Response object directly (the dispatcher passes it through).
//
// Returns a Response (binary); dispatcher must passthrough.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { repos } from '~/lib/db/schema'
import { parseCid } from '~/pds/codec'
import { encodeCarChunks, type CarBlock } from '~/pds/car/encode'
import { getBlock } from '~/pds/repo/blockstore'
import { collectRepoCids } from '~/pds/repo/sync'

const handler: Handler = async ({ params }) => {
  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  const rows = await db
    .select({ rootCid: repos.rootCid })
    .from(repos)
    .where(eq(repos.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')

  const commitCid = parseCid(row.rootCid)
  // NOTE: `since=<rev>` is accepted by the lexicon but ignored here; serving
  // only newer blocks requires either time-tagged block rows or an old MST
  // root to diff against. We return the full repo and let the client filter.
  const cids = await collectRepoCids(did, commitCid)

  const blockStream: AsyncIterable<CarBlock> = (async function* () {
    for (const cid of cids) {
      const b = await getBlock(did, cid)
      if (!b) throw new Error(`block disappeared mid-stream: ${cid}`)
      yield { cid: b.cid, bytes: b.bytes }
    }
  })()

  const car = encodeCarChunks({ roots: [commitCid], blocks: blockStream })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await car.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.ipld.car',
      'cache-control': 'no-store',
    },
  })
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getRepo'
