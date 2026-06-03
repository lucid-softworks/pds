// XRPC handler: com.atproto.repo.importRepo
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/importRepo.json
//
// Destination-side. The migrating user POSTs the CAR they downloaded from
// their old PDS via `getRepo`. We stream-verify it, persist every block,
// rewrite `repos.root_cid` to the imported root, rebuild the records and
// record_blobs indexes by walking the imported MST, and emit a `#commit`
// event so federation sees the new history.
//
// The import path deliberately bypasses applyWrites: we trust the imported
// CAR's commit signature rather than replaying individual writes. The
// signing key in the commit must match what's on the account row (the new
// PDS reserved that key earlier via reserveSigningKey, and the user rotated
// their PLC to point at it).
//
// We only accept an import into a *fresh* repo — one whose MST is still the
// empty-genesis tree. Re-importing on top of existing records would either
// orphan their blocks or silently drop them; both are worse than refusing.
//
// See chapter 20 — Migration.

import { eq, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts, repos, records, recordBlobs } from '~/lib/db/schema'
import { decode, type Block, type CID } from '~/pds/codec'
import { decodeCarChunks } from '~/pds/car/decode'
import { encodeCar } from '~/pds/car/encode'
import {
  decodeCommit,
  verifyCommit,
  type SignedCommit,
} from '~/pds/repo/commit'
import { putBlocks, getBlock } from '~/pds/repo/blockstore'
import { MST } from '~/pds/repo/mst'
import { blockStoreForDid } from '~/pds/repo/writes'
import { extractBlobCids } from '~/pds/blob/refs'
import { emitCommit, type CommitOp } from '~/pds/sequencer/sequence'
import { requireAuthWithScope } from '~/pds/auth/middleware'

const handler: Handler = async ({ authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  if (!request.body) {
    throw BadRequest('request body is required', 'InvalidRequest')
  }

  // 0. Refuse to import into a non-empty repo. We use the records index as
  // the cheap proxy — a fresh genesis has zero rows.
  const existingRecordCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(records)
    .where(eq(records.repoDid, me.did))
  if ((existingRecordCount[0]?.n ?? 0) > 0) {
    throw BadRequest('cannot import into a non-empty repo', 'RepoNotEmpty')
  }

  // 1. Look up the account's signing pub so we can verify the imported
  // commit. For a real migration this is the key the destination PDS
  // reserved earlier and which landed on accounts.signing_key_pub when the
  // account row was first created (a follow-up — see chapter 20's gap list).
  const accountRows = await db
    .select({ signingKeyPub: accounts.signingKeyPub })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const account = accountRows[0]
  if (!account) {
    throw BadRequest(`unknown account: ${me.did}`, 'InvalidRequest')
  }

  // 2. Stream-decode the CAR. The decoder hash-verifies every block as it
  // arrives — by the time we exit the loop, every block's bytes have been
  // proved to match its declared CID.
  const blocksByCid = new Map<string, Block>()
  let rootCid: CID | null = null
  for await (const event of decodeCarChunks(
    toBytesAsyncIterable(request.body),
  )) {
    if (event.type === 'header') {
      const first = event.header.roots[0]
      if (!first) {
        throw BadRequest('CAR header has no roots', 'InvalidCar')
      }
      rootCid = first
      continue
    }
    blocksByCid.set(event.cid.toString(), {
      cid: event.cid,
      bytes: event.bytes,
    })
  }
  if (!rootCid) {
    throw BadRequest('CAR stream ended before header', 'InvalidCar')
  }
  const rootBlock = blocksByCid.get(rootCid.toString())
  if (!rootBlock) {
    throw BadRequest('CAR root block missing from body', 'InvalidCar')
  }

  // 3. Verify the root is a signed commit, parse it, and check the signature.
  let commit: SignedCommit
  try {
    commit = await decodeCommit(rootBlock.bytes)
  } catch (err) {
    throw BadRequest(
      `CAR root is not a signed commit: ${(err as Error).message}`,
      'InvalidRequest',
    )
  }
  if (commit.did !== me.did) {
    throw BadRequest(
      `commit DID does not match caller: ${commit.did} vs ${me.did}`,
      'InvalidRequest',
    )
  }
  const sigOk = await verifyCommit(rootBlock.bytes, account.signingKeyPub)
  if (!sigOk) {
    throw BadRequest(
      'commit signature does not verify against account signing key',
      'InvalidRequest',
    )
  }

  // 4. Persist every block, idempotently.
  const allBlocks = [...blocksByCid.values()]
  await putBlocks(me.did, allBlocks)

  // 5. Rewrite the repo head to point at the imported commit.
  await db
    .update(repos)
    .set({ rootCid: rootCid.toString(), rev: commit.rev })
    .where(eq(repos.did, me.did))

  // 6. Walk the imported MST and rebuild the records index. The MST is the
  // authoritative store; this table is the read cache. Harvest blob refs in
  // the same pass for record_blobs.
  const store = blockStoreForDid(me.did)
  const mst = await MST.load(commit.data, store)
  const ops: CommitOp[] = []
  const indexedAt = new Date()
  for await (const leaf of mst.list()) {
    const slash = leaf.key.indexOf('/')
    if (slash < 1) continue
    const collection = leaf.key.slice(0, slash)
    const rkey = leaf.key.slice(slash + 1)
    const uri = `at://${me.did}/${collection}/${rkey}`
    await db
      .insert(records)
      .values({
        repoDid: me.did,
        collection,
        rkey,
        cid: leaf.cid.toString(),
        indexedAt,
      })
      .onConflictDoUpdate({
        target: [records.repoDid, records.collection, records.rkey],
        set: { cid: leaf.cid.toString(), indexedAt },
      })
    // Each imported record looks like a `create` to a downstream consumer
    // that had no prior state for this repo — exactly the right signal for
    // a fresh-on-this-PDS account.
    ops.push({ action: 'create', path: leaf.key, cid: leaf.cid })

    const valueBlock = await getBlock(me.did, leaf.cid)
    if (!valueBlock) continue
    let value: unknown
    try {
      value = await decode(valueBlock.bytes)
    } catch {
      continue
    }
    for (const blobCid of extractBlobCids(value)) {
      await db
        .insert(recordBlobs)
        .values({ repoDid: me.did, recordUri: uri, blobCid })
        .onConflictDoNothing()
    }
  }

  // 7. Flag the account as migration-in (so the firehose can label this
  // commit distinctly) and ship the event. Re-encode the CAR from the
  // deduped block set so consumers see exactly the bytes `getRepo` would
  // hand them on this PDS.
  await db
    .update(accounts)
    .set({ migrationState: 'migrating-in' })
    .where(eq(accounts.did, me.did))

  const carBytes = await encodeCar({ roots: [rootCid], blocks: allBlocks })
  await emitCommit({
    did: me.did,
    commitCid: rootCid,
    rev: commit.rev,
    prevRev: null,
    carBytes,
    ops,
  })

  return undefined
}

/** Convert a web ReadableStream of Uint8Array into an AsyncIterable for the
 *  CAR decoder. Node's WHATWG ReadableStream is already async-iterable at
 *  runtime, but the TypeScript lib types don't expose that on Web streams. */
async function* toBytesAsyncIterable(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.repo.importRepo'
