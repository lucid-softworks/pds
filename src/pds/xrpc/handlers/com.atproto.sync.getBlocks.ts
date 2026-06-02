// XRPC handler: com.atproto.sync.getBlocks
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getBlocks.json
//
// Return the listed blocks as a CAR. Used by consumers that already know
// which blocks they need (e.g. resolving a CID they saw on the firehose).
//
// Returns a Response (binary); dispatcher must passthrough.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { repos } from '~/lib/db/schema'
import { encodeCar } from '~/pds/car/encode'
import { getBlocks } from '~/pds/repo/blockstore'
import { parseCidList } from '~/pds/repo/sync'

const handler: Handler = async ({ params, request }) => {
  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  // The lexicon uses repeated `cids` query params, which `Object.fromEntries`
  // collapsed to a single value. Re-read from the URL to get the full list.
  const url = new URL(request.url)
  const cidStrings = url.searchParams.getAll('cids')
  if (cidStrings.length === 0) {
    throw BadRequest('cids parameter is required', 'InvalidRequest')
  }
  const cids = parseCidList(cidStrings)

  const repoRow = await db
    .select({ did: repos.did })
    .from(repos)
    .where(eq(repos.did, did))
    .limit(1)
  if (!repoRow[0]) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')

  const stored = await getBlocks(did, cids)
  // The CAR spec allows zero roots — but to keep firehose-style consumers
  // happy we use the first requested CID as the conventional root. The
  // upstream getBlocks endpoint does the same.
  const roots = cids.slice(0, 1)
  const car = await encodeCar({ roots, blocks: stored })
  return new Response(carBody(car), {
    status: 200,
    headers: {
      'content-type': 'application/vnd.ipld.car',
      'cache-control': 'no-store',
    },
  })
}

/** Wrap a CAR byte buffer in a single-chunk ReadableStream. Avoids the
 *  `Uint8Array<ArrayBufferLike>` vs `BodyInit` mismatch in current TS libs
 *  while staying allocation-free at the byte level. */
function carBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getBlocks'
