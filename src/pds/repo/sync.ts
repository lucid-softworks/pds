// Sync helpers: walk a repo's blocks for CAR export.
//
// The sync XRPC endpoints (com.atproto.sync.*) need to enumerate the blocks
// reachable from a commit: the commit itself, the MST root, every internal
// MST node, and every leaf value (each record's CID). We do this with a
// manual depth-first traversal over the MST's wire shape rather than
// reaching into MST internals — see chapter 08 for the rationale.

import { decode, parseCid, type CID } from '~/pds/codec'
import { getBlock } from './blockstore'
import type { SignedCommit } from './commit'
import type { MstNode } from './mst'

/** Walk the commit + MST + leaves and collect every reachable CID, in DFS
 *  order (commit first, then MST root, then subtree, then leaves under it).
 *  Caller is responsible for fetching block bytes and yielding CAR blocks. */
export async function collectRepoCids(
  repoDid: string,
  commitCid: CID,
): Promise<CID[]> {
  const commitBlock = await getBlock(repoDid, commitCid)
  if (!commitBlock) throw new Error(`commit block missing: ${commitCid}`)
  const commit = await decode<SignedCommit>(commitBlock.bytes, commitCid)

  const out: CID[] = [commitCid]
  await walkMst(repoDid, commit.data, out, new Set([commitCid.toString()]))
  return out
}

/** Manual MST walk. Loads each MST node, recurses into `l` and every entry's
 *  `t` pointer, and pushes every leaf value CID. Avoids re-visiting nodes
 *  that have already been collected (structural sharing across commits). */
async function walkMst(
  repoDid: string,
  nodeCid: CID,
  out: CID[],
  seen: Set<string>,
): Promise<void> {
  const key = nodeCid.toString()
  if (seen.has(key)) return
  seen.add(key)
  out.push(nodeCid)

  const block = await getBlock(repoDid, nodeCid)
  if (!block) throw new Error(`MST node block missing: ${nodeCid}`)
  const node = await decode<MstNode>(block.bytes, nodeCid)

  if (node.l) await walkMst(repoDid, node.l, out, seen)
  for (const entry of node.e) {
    // Each entry is a (key, value) leaf plus an optional right-subtree
    // pointer. The value CID points at a record block; we treat it as a
    // leaf and don't recurse — records are opaque to the MST.
    const valueKey = entry.v.toString()
    if (!seen.has(valueKey)) {
      seen.add(valueKey)
      out.push(entry.v)
    }
    if (entry.t) await walkMst(repoDid, entry.t, out, seen)
  }
}

/** Walk the MST collecting only the *proof* blocks for a given key: the
 *  commit, the MST nodes on the path to the leaf, and the value CID. Used
 *  by getRecord to ship a small Merkle proof rather than the whole repo. */
export async function collectRecordProofCids(
  repoDid: string,
  commitCid: CID,
  recordKey: string,
): Promise<{ cids: CID[]; valueCid: CID | null }> {
  const commitBlock = await getBlock(repoDid, commitCid)
  if (!commitBlock) throw new Error(`commit block missing: ${commitCid}`)
  const commit = await decode<SignedCommit>(commitBlock.bytes, commitCid)

  const cids: CID[] = [commitCid]
  const valueCid = await walkPath(
    repoDid,
    commit.data,
    recordKey,
    cids,
    new Set([commitCid.toString()]),
  )
  return { cids, valueCid }
}

async function walkPath(
  repoDid: string,
  nodeCid: CID,
  recordKey: string,
  out: CID[],
  seen: Set<string>,
): Promise<CID | null> {
  const key = nodeCid.toString()
  if (!seen.has(key)) {
    seen.add(key)
    out.push(nodeCid)
  }
  const block = await getBlock(repoDid, nodeCid)
  if (!block) throw new Error(`MST node block missing: ${nodeCid}`)
  const node = await decode<MstNode>(block.bytes, nodeCid)

  // Reconstruct keys to decide which subtree the recordKey falls into.
  const decoder = new TextDecoder()
  let prevKey: string | null = null
  let priorPointer: CID | null = node.l
  for (const e of node.e) {
    let entryKey: string
    if (prevKey !== null && e.p > 0) {
      const prevBytes = new TextEncoder().encode(prevKey)
      const merged = new Uint8Array(e.p + e.k.length)
      merged.set(prevBytes.subarray(0, e.p), 0)
      merged.set(e.k, e.p)
      entryKey = decoder.decode(merged)
    } else {
      entryKey = decoder.decode(e.k)
    }

    if (recordKey === entryKey) {
      const valueKey = e.v.toString()
      if (!seen.has(valueKey)) {
        seen.add(valueKey)
        out.push(e.v)
      }
      return e.v
    }
    if (recordKey < entryKey) {
      // Descend through the pointer just before this leaf.
      if (priorPointer) return await walkPath(repoDid, priorPointer, recordKey, out, seen)
      return null
    }
    prevKey = entryKey
    priorPointer = e.t
  }
  // recordKey is greater than every leaf in this node — descend rightmost.
  if (priorPointer) return await walkPath(repoDid, priorPointer, recordKey, out, seen)
  return null
}

/** Parse a list of stringified CIDs, ignoring blanks. Throws on malformed. */
export function parseCidList(values: string[]): CID[] {
  const out: CID[] = []
  for (const v of values) {
    const trimmed = v.trim()
    if (trimmed.length === 0) continue
    out.push(parseCid(trimmed))
  }
  return out
}
