// XRPC handler: com.atproto.sync.getRepo
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getRepo.json
//
// Returns the full repository as a CAR. The response is binary; we build a
// Response object directly (the dispatcher passes it through).
//
// Returns a Response (binary); dispatcher must passthrough.

import { and, eq, gt, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts, repoBlocks, repos } from '~/lib/db/schema'
import { parseCid } from '~/pds/codec'
import { encodeCarChunks, type CarBlock } from '~/pds/car/encode'
import { getBlock } from '~/pds/repo/blockstore'
import { collectRepoCids } from '~/pds/repo/sync'

const handler: Handler = async ({ params }) => {
  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  const rows = await db
    .select({ rootCid: repos.rootCid, status: accounts.status })
    .from(repos)
    .innerJoin(accounts, eq(accounts.did, repos.did))
    .where(eq(repos.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')
  if (row.status === 'takendown') {
    throw NotFound(`repo takendown: ${did}`, 'RepoTakendown')
  }
  if (row.status === 'deactivated') {
    throw NotFound(`repo deactivated: ${did}`, 'RepoDeactivated')
  }
  if (row.status === 'deleted') {
    throw NotFound(`repo deleted: ${did}`, 'RepoNotFound')
  }

  const commitCid = parseCid(row.rootCid)
  const since = params.since?.trim()

  // `since=<rev>` is incremental: stream only the blocks written at a
  // commit rev later than the caller's cursor. Each block carries a
  // `repo_rev` (added in migration 0023) — the rev at which its bytes
  // first landed. We query that table directly instead of walking the
  // MST so the result is the strict diff, no recompute. NULL revs are
  // pre-migration rows; treated as "before any rev a client could
  // have seen," so a since=<any> query correctly excludes them.
  let blockStream: AsyncIterable<CarBlock>
  if (since !== undefined && since.length > 0) {
    blockStream = (async function* () {
      for await (const row of streamSinceRev(did, since)) {
        yield row
      }
    })()
  } else {
    const cids = await collectRepoCids(did, commitCid)
    blockStream = (async function* () {
      for (const cid of cids) {
        const b = await getBlock(did, cid)
        if (!b) throw new Error(`block disappeared mid-stream: ${cid}`)
        yield { cid: b.cid, bytes: b.bytes }
      }
    })()
  }

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

async function* streamSinceRev(
  did: string,
  since: string,
): AsyncGenerator<CarBlock> {
  // Page through repo_blocks with `repo_rev > since` ordered by rev
  // asc so streaming bytes appear in commit order. The page size
  // keeps memory bounded for repos with thousands of revs.
  const PAGE = 256
  let lastCid: string | null = null
  // Composite cursor: (repo_rev, cid). The query uses a row-comparison
  // tuple so the index on (repo_did, repo_rev) carries the sort.
  let lastRev: string | null = null
  while (true) {
    const rows = await db
      .select({
        cid: repoBlocks.cid,
        bytes: repoBlocks.bytes,
        repoRev: repoBlocks.repoRev,
      })
      .from(repoBlocks)
      .where(
        and(
          eq(repoBlocks.repoDid, did),
          gt(repoBlocks.repoRev, since),
          lastRev !== null
            ? sql`(${repoBlocks.repoRev}, ${repoBlocks.cid}) > (${lastRev}, ${lastCid})`
            : undefined,
        ),
      )
      .orderBy(repoBlocks.repoRev, repoBlocks.cid)
      .limit(PAGE)
    if (rows.length === 0) return
    for (const r of rows) {
      yield { cid: parseCid(r.cid), bytes: r.bytes }
    }
    lastRev = rows[rows.length - 1]!.repoRev ?? null
    lastCid = rows[rows.length - 1]!.cid
    if (rows.length < PAGE) return
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getRepo'
