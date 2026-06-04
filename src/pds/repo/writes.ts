// Repo write orchestrator.
//
// One function — applyWrites — owns the full write cycle for a repo:
//
//   1. Load the account's signing key + current commit state.
//   2. Optionally enforce a swapCommit precondition.
//   3. Load the current MST from the persisted commit's `data` field.
//   4. Validate every write (NSID syntax, rkey shape, $type presence).
//   5. Encode each new record value into a block; mutate the MST in order.
//   6. Serialize the MST → root CID + new blocks.
//   7. Build + sign a new commit pointing at the new MST root.
//   8. Persist new blocks, update repos(root_cid, rev), update records index.
//
// One commit per call. createRecord / putRecord / deleteRecord are thin
// wrappers that call this with a single-element batch; applyWrites is the
// direct surface for the XRPC method of the same name.
//
// See chapter 14 — Records.

import { eq, and } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, repos, records, recordBlobs } from '~/lib/db/schema'
import { getKeyWrapper } from '~/pds/auth/key_wrap'
import {
  encode,
  parseCid,
  cidEquals,
  type Block,
  type CID,
} from '~/pds/codec'
import { Conflict, BadRequest, NotFound } from '~/pds/xrpc/errors'
import { MST, type BlockStore } from './mst'
import { buildSignedCommit, decodeCommit } from './commit'
import { nextTid, isValidTid } from './tid'
import { getBlock, putBlocks } from './blockstore'
import { encodeCar } from '~/pds/car/encode'
import { emitCommit } from '~/pds/sequencer/sequence'
import { extractBlobCids } from '~/pds/blob/refs'

export type Write =
  | { action: 'create'; collection: string; rkey?: string; value: unknown }
  | { action: 'update'; collection: string; rkey: string; value: unknown }
  | { action: 'delete'; collection: string; rkey: string }

export type AppliedWrite = {
  action: 'create' | 'update' | 'delete'
  uri: string
  cid: CID | null
}

export type ApplyResult = {
  commit: { cid: CID; rev: string }
  writes: AppliedWrite[]
}

const NSID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+(\.[a-zA-Z][a-zA-Z0-9]*)$/
const RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/

/** Per-repo view over the global `repo_blocks` table, in the shape MST.load
 *  wants. The MST never writes through this — new blocks come back via
 *  getRoot() and the caller persists them. */
export function blockStoreForDid(did: string): BlockStore {
  return {
    async getBlock(cid: CID): Promise<Uint8Array | null> {
      const block = await getBlock(did, cid)
      return block ? block.bytes : null
    },
  }
}

export async function applyWrites(args: {
  did: string
  writes: Write[]
  swapCommit?: string
}): Promise<ApplyResult> {
  if (args.writes.length === 0) {
    throw BadRequest('applyWrites requires at least one write', 'InvalidRequest')
  }

  // 1. Load signing key + current repo state.
  const accountRows = await db
    .select({
      did: accounts.did,
      signingKeyPriv: accounts.signingKeyPriv,
    })
    .from(accounts)
    .where(eq(accounts.did, args.did))
    .limit(1)
  const account = accountRows[0]
  if (!account) {
    throw NotFound(`unknown repo: ${args.did}`, 'RepoNotFound')
  }

  const repoRows = await db
    .select()
    .from(repos)
    .where(eq(repos.did, args.did))
    .limit(1)
  const repoRow = repoRows[0]
  if (!repoRow) {
    throw NotFound(`repo not initialized: ${args.did}`, 'RepoNotFound')
  }

  // 2. swapCommit precondition.
  if (args.swapCommit && args.swapCommit !== repoRow.rootCid) {
    throw Conflict(
      `swapCommit mismatch: expected ${args.swapCommit}, current ${repoRow.rootCid}`,
      'InvalidSwap',
    )
  }

  // 3. Load the current commit, then the MST it points at.
  //
  // The repos.root_cid column is the *commit* CID; the MST root sits in the
  // commit's `data` field. Loading the MST directly off root_cid would
  // misinterpret the commit block as an MST node.
  const store = blockStoreForDid(args.did)
  const currentCommitCid = parseCid(repoRow.rootCid)
  const commitBytes = await store.getBlock(currentCommitCid)
  if (!commitBytes) {
    throw NotFound(
      `commit block missing for ${args.did}: ${repoRow.rootCid}`,
      'RepoNotFound',
    )
  }
  const currentCommit = await decodeCommit(commitBytes)
  let mst = await MST.load(currentCommit.data, store)

  // 4-5. Validate + apply writes. Pre-encode every record value so we know
  // the CID before mutating the tree.
  const newBlocks: Block[] = []
  const indexOps: IndexOp[] = []
  const blobOps: BlobOp[] = []
  const applied: AppliedWrite[] = []

  for (const w of args.writes) {
    if (!NSID_RE.test(w.collection)) {
      throw BadRequest(`invalid collection NSID: ${w.collection}`, 'InvalidRequest')
    }

    if (w.action === 'create') {
      const rkey = w.rkey ?? nextTid()
      assertValidRkey(rkey)
      assertHasType(w.value)
      const block = await encode(w.value)
      newBlocks.push(block)
      mst = await safeMstAdd(mst, w.collection, rkey, block.cid)
      const uri = makeUri(args.did, w.collection, rkey)
      indexOps.push({
        kind: 'upsert',
        collection: w.collection,
        rkey,
        cid: block.cid.toString(),
      })
      collectBlobOps(blobOps, args.did, uri, w.value, /*detachFirst*/ false)
      applied.push({ action: 'create', uri, cid: block.cid })
      continue
    }

    if (w.action === 'update') {
      assertValidRkey(w.rkey)
      assertHasType(w.value)
      const block = await encode(w.value)
      newBlocks.push(block)
      mst = await safeMstUpdate(mst, w.collection, w.rkey, block.cid)
      const uri = makeUri(args.did, w.collection, w.rkey)
      indexOps.push({
        kind: 'upsert',
        collection: w.collection,
        rkey: w.rkey,
        cid: block.cid.toString(),
      })
      // Update: clear old attachments before re-attaching from the new value.
      // The simple swap covers added refs, removed refs, and unchanged refs
      // in one shape — no diffing needed.
      collectBlobOps(blobOps, args.did, uri, w.value, /*detachFirst*/ true)
      applied.push({ action: 'update', uri, cid: block.cid })
      continue
    }

    // delete
    assertValidRkey(w.rkey)
    mst = await safeMstDelete(mst, w.collection, w.rkey)
    const uri = makeUri(args.did, w.collection, w.rkey)
    indexOps.push({
      kind: 'delete',
      collection: w.collection,
      rkey: w.rkey,
    })
    blobOps.push({ kind: 'detach', repoDid: args.did, recordUri: uri })
    applied.push({ action: 'delete', uri, cid: null })
  }

  // 6. Serialize the new tree.
  const { cid: newMstRoot, blocks: mstBlocks } = await mst.getRoot()
  newBlocks.push(...mstBlocks)

  // 7. Build the signed commit. The DB column is wrapped at rest (see
  //    `~/pds/auth/key_wrap`); we unwrap through the dispatcher, which
  //    handles `plain:`, `gcm:`, bare-hex legacy rows, etc.
  const rev = nextTid()
  const signingKeyPrivPlain = await getKeyWrapper().unwrap(
    account.signingKeyPriv,
  )
  const commitBlock = await buildSignedCommit({
    did: args.did,
    data: newMstRoot,
    rev,
    signingKeyPriv: signingKeyPrivPlain,
  })
  newBlocks.push(commitBlock)

  // 8. Persist. PGlite + postgres-js both expose db.transaction; if the
  // driver throws we fall back to best-effort sequential writes — the orphan
  // blocks are harmless (content-addressed, eventually pruned).
  try {
    await db.transaction(async (tx) => {
      await persistCommit(tx, {
        did: args.did,
        blocks: newBlocks,
        newRootCid: commitBlock.cid.toString(),
        newRev: rev,
        indexOps,
        blobOps,
      })
    })
  } catch (err) {
    if (isMissingTransactionSupport(err)) {
      await persistCommit(db, {
        did: args.did,
        blocks: newBlocks,
        newRootCid: commitBlock.cid.toString(),
        newRev: rev,
        indexOps,
        blobOps,
      })
    } else {
      throw err
    }
  }

  // 9. Emit a #commit firehose event. We bundle the dirty blocks as a CAR
  //    with the new commit as root — that's exactly what subscribeRepos will
  //    send to consumers byte-for-byte.
  const dedupedForCar = Array.from(
    new Map(newBlocks.map((b) => [b.cid.toString(), b])).values(),
  )
  const carBytes = await encodeCar({
    roots: [commitBlock.cid],
    blocks: dedupedForCar,
  })
  const pathPrefix = `at://${args.did}/`
  await emitCommit({
    did: args.did,
    commitCid: commitBlock.cid,
    rev,
    prevRev: currentCommit.rev,
    carBytes,
    ops: applied.map((a) => ({
      action: a.action,
      path: a.uri.startsWith(pathPrefix) ? a.uri.slice(pathPrefix.length) : a.uri,
      cid: a.cid,
    })),
  })

  return {
    commit: { cid: commitBlock.cid, rev },
    writes: applied,
  }
}

// ---------- helpers ----------

type IndexOp =
  | { kind: 'upsert'; collection: string; rkey: string; cid: string }
  | { kind: 'delete'; collection: string; rkey: string }

type BlobOp =
  | { kind: 'attach'; repoDid: string; recordUri: string; blobCid: string }
  | { kind: 'detach'; repoDid: string; recordUri: string }

type PersistArgs = {
  did: string
  blocks: Block[]
  newRootCid: string
  newRev: string
  indexOps: IndexOp[]
  blobOps: BlobOp[]
}

// We accept `any` here because drizzle's tx type differs by driver and the
// two callers (a real transaction handle and the bare db) share only the
// subset of methods we use.
type WriteHandle = {
  update: typeof db.update
  insert: typeof db.insert
  delete: typeof db.delete
}

function collectBlobOps(
  out: BlobOp[],
  repoDid: string,
  recordUri: string,
  value: unknown,
  detachFirst: boolean,
): void {
  if (detachFirst) {
    out.push({ kind: 'detach', repoDid, recordUri })
  }
  for (const blobCid of extractBlobCids(value)) {
    out.push({ kind: 'attach', repoDid, recordUri, blobCid })
  }
}

async function persistCommit(handle: WriteHandle, args: PersistArgs): Promise<void> {
  // Dedup blocks by CID — the MST may revisit the same untouched subtree.
  const dedup = new Map<string, Block>()
  for (const b of args.blocks) dedup.set(b.cid.toString(), b)
  // Pass the open tx (or the bare db, for the no-transaction fallback) so the
  // block-store insert lands in the same connection as the records-table
  // mutations. Mixing in a write through the global `db` proxy here would
  // deadlock on single-connection drivers (PGlite holds the tx lock while
  // the outside write waits on it).
  //
  // Each block is tagged with the commit rev (TID) at which it was first
  // written so `sync.getRepo?since=<rev>` can filter the CAR by
  // `repo_rev > since`. Blocks already in repo_blocks keep their original
  // rev (the ON CONFLICT DO NOTHING in putBlocks declines to update).
  await putBlocks(args.did, [...dedup.values()], handle, args.newRev)

  await handle
    .update(repos)
    .set({ rootCid: args.newRootCid, rev: args.newRev })
    .where(eq(repos.did, args.did))

  for (const op of args.indexOps) {
    if (op.kind === 'upsert') {
      await handle
        .insert(records)
        .values({
          repoDid: args.did,
          collection: op.collection,
          rkey: op.rkey,
          cid: op.cid,
          rev: args.newRev,
        })
        .onConflictDoUpdate({
          target: [records.repoDid, records.collection, records.rkey],
          set: { cid: op.cid, indexedAt: new Date(), rev: args.newRev },
        })
    } else {
      await handle
        .delete(records)
        .where(
          and(
            eq(records.repoDid, args.did),
            eq(records.collection, op.collection),
            eq(records.rkey, op.rkey),
          ),
        )
    }
  }

  // Blob attachments. Order is significant: an update emits a detach followed
  // by zero-or-more attaches for the same URI; running attach-before-detach
  // would wipe the rows we just inserted.
  for (const op of args.blobOps) {
    if (op.kind === 'detach') {
      await handle
        .delete(recordBlobs)
        .where(
          and(
            eq(recordBlobs.repoDid, op.repoDid),
            eq(recordBlobs.recordUri, op.recordUri),
          ),
        )
    } else {
      await handle
        .insert(recordBlobs)
        .values({
          repoDid: op.repoDid,
          recordUri: op.recordUri,
          blobCid: op.blobCid,
        })
        .onConflictDoNothing()
    }
  }
}

function isMissingTransactionSupport(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const msg = (err as { message?: string }).message ?? ''
  return /transaction/i.test(msg) && /not (a function|supported|implemented)/i.test(msg)
}

async function safeMstAdd(
  mst: MST,
  collection: string,
  rkey: string,
  cid: CID,
): Promise<MST> {
  const key = `${collection}/${rkey}`
  const existing = await mst.get(key)
  if (existing) {
    throw Conflict(
      `record already exists at ${key}`,
      'InvalidRequest',
    )
  }
  return await mst.add(key, cid)
}

async function safeMstUpdate(
  mst: MST,
  collection: string,
  rkey: string,
  cid: CID,
): Promise<MST> {
  const key = `${collection}/${rkey}`
  const existing = await mst.get(key)
  if (!existing) {
    throw NotFound(`record not found at ${key}`, 'RecordNotFound')
  }
  if (cidEquals(existing, cid)) return mst
  return await mst.update(key, cid)
}

async function safeMstDelete(
  mst: MST,
  collection: string,
  rkey: string,
): Promise<MST> {
  const key = `${collection}/${rkey}`
  const existing = await mst.get(key)
  if (!existing) {
    throw NotFound(`record not found at ${key}`, 'RecordNotFound')
  }
  return await mst.delete(key)
}

function assertValidRkey(rkey: string): void {
  // rkeys are either TIDs (the default for new records) or a free-form
  // subset, e.g. "self" for the singleton profile record. We accept both.
  if (rkey === 'self') return
  if (isValidTid(rkey)) return
  if (!RKEY_RE.test(rkey)) {
    throw BadRequest(`invalid rkey: ${rkey}`, 'InvalidRequest')
  }
}

function assertHasType(value: unknown): void {
  if (!value || typeof value !== 'object') {
    throw BadRequest('record value must be an object', 'InvalidRequest')
  }
  const t = (value as { $type?: unknown }).$type
  if (typeof t !== 'string' || t.length === 0) {
    throw BadRequest('record value must include $type', 'InvalidRequest')
  }
}

function makeUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}
