// Merkle Search Tree — full implementation.
//
// The MST is the load-bearing data structure for repositories. Keys map to
// value CIDs; the tree is content-addressed, deterministic (same set of
// (key, value) pairs always produces the same root CID regardless of
// insertion order), and supports efficient diffs.
//
// On-wire shape (DAG-CBOR, canonical):
//
//   type MstNode = {
//     l: CID | null      // leftmost subtree pointer
//     e: Array<{
//       p: number        // bytes of prefix shared with previous key in node
//       k: Uint8Array    // utf8 key bytes after the shared prefix
//       v: CID           // value CID
//       t: CID | null    // right-subtree pointer (keys > this, < next)
//     }>
//   }
//
// Internal shape — we keep an interleaved list of leaves and subtree pointers
// because that mirrors how the algorithms operate. `serialize()` converts
// to the on-wire form; `parse()` reverses it.
//
// See docs/06-merkle-search-tree.md for the conceptual walkthrough.
//
// Spec: https://atproto.com/specs/repository#mst-data-structure

import { sha256 } from '@noble/hashes/sha256'
import {
  encode,
  decode,
  cidEquals,
  type Block,
  type CID,
} from '~/pds/codec'

// ---------- Public types ----------

export type MstNode = {
  l: CID | null
  e: MstEntry[]
}

export type MstEntry = {
  p: number
  k: Uint8Array
  v: CID
  t: CID | null
}

export interface BlockStore {
  getBlock(cid: CID): Promise<Uint8Array | null>
}

export type MstDiff = {
  adds: Map<string, CID>
  updates: Map<string, [CID, CID]>
  deletes: Map<string, CID>
  newBlocks: Block[]
  removedCids: CID[]
}

// ---------- Internal node representation ----------

type Leaf = { kind: 'leaf'; key: string; value: CID }
type Pointer = { kind: 'tree'; tree: Tree }
type NodeEntry = Leaf | Pointer

/** A `Tree` is one MST node plus its known children. Trees can be unloaded
 *  (only a CID is known) — we lazily fault them in from the BlockStore. */
class Tree {
  // Either `loaded` is true and `entries` is authoritative, or `loaded` is
  // false and we know only `cid` + `store` (and `depth`, inferred from
  // parent context).
  loaded: boolean
  entries: NodeEntry[]
  // Cached on first call to `getCid`.
  private _cid: CID | null
  private _bytes: Uint8Array | null
  // The depth of this node in the tree. -1 means "unknown / empty tree".
  // For loaded non-empty nodes, equals the leading-zero-hex-count of every
  // leaf's key at this node.
  depth: number
  readonly store: BlockStore | null

  constructor(opts: {
    entries: NodeEntry[]
    depth: number
    store?: BlockStore | null
    cid?: CID | null
    bytes?: Uint8Array | null
    loaded?: boolean
  }) {
    this.entries = opts.entries
    this.depth = opts.depth
    this.store = opts.store ?? null
    this._cid = opts.cid ?? null
    this._bytes = opts.bytes ?? null
    this.loaded = opts.loaded ?? true
  }

  static unloaded(cid: CID, depth: number, store: BlockStore): Tree {
    return new Tree({
      entries: [],
      depth,
      store,
      cid,
      bytes: null,
      loaded: false,
    })
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this._cid || !this.store) {
      this.loaded = true
      return
    }
    const bytes = await this.store.getBlock(this._cid)
    if (!bytes) throw new Error(`MST block missing: ${this._cid.toString()}`)
    const node = await decode<MstNode>(bytes, this._cid)
    this.entries = expandNode(node, this.depth, this.store)
    this._bytes = bytes
    this.loaded = true
  }

  /** Get the CID for this node, encoding lazily and caching the result.
   *  `collected` accumulates blocks created during this call. For nodes
   *  loaded from storage (with `_cid` already set) we return without
   *  touching `entries`, so untouched subtrees never get re-encoded. */
  async getCid(collected: Block[]): Promise<CID> {
    if (this._cid && !this._dirty) return this._cid
    await this.ensureLoaded()
    const onWire = await serialize(this.entries, collected)
    const block = await encode(onWire)
    this._cid = block.cid
    this._bytes = block.bytes
    this._dirty = false
    collected.push(block)
    return this._cid
  }

  // Mark dirty when entries are replaced. We just always recompute when
  // `_cid` is null; this flag lets us mutate `entries` once and then encode.
  private _dirty = false
  markDirty(): void {
    this._cid = null
    this._bytes = null
    this._dirty = true
  }

  isEmpty(): boolean {
    return this.entries.length === 0
  }
}

// ---------- Hashing / depth ----------

/** Depth of a key = number of leading zero hex characters in sha256(utf8(key)). */
export function leadingZerosOnHash(key: string): number {
  const h = sha256(new TextEncoder().encode(key))
  let count = 0
  for (let i = 0; i < h.length; i++) {
    const b = h[i]!
    const hi = (b >> 4) & 0xf
    if (hi !== 0) return count
    count++
    const lo = b & 0xf
    if (lo !== 0) return count
    count++
  }
  return count
}

// ---------- Serialization helpers ----------

/** Convert internal entries to the on-wire `MstNode`. For child pointers,
 *  recursively encode any new/dirty children first. */
async function serialize(
  entries: NodeEntry[],
  collected: Block[],
): Promise<MstNode> {
  // The first non-leaf entry, if it sits before any leaf, is the left pointer.
  let l: CID | null = null
  let i = 0
  if (entries.length > 0 && entries[0]!.kind === 'tree') {
    l = await (entries[0]! as Pointer).tree.getCid(collected)
    i = 1
  }
  const e: MstEntry[] = []
  let prevKey: string | null = null
  while (i < entries.length) {
    const cur = entries[i]!
    if (cur.kind !== 'leaf') {
      throw new Error('MST node out of shape: expected leaf')
    }
    let t: CID | null = null
    const next = entries[i + 1]
    if (next && next.kind === 'tree') {
      t = await next.tree.getCid(collected)
      i += 2
    } else {
      i += 1
    }
    const keyBytes = new TextEncoder().encode(cur.key)
    let p = 0
    if (prevKey !== null) {
      const prevBytes = new TextEncoder().encode(prevKey)
      const max = Math.min(prevBytes.length, keyBytes.length)
      while (p < max && prevBytes[p] === keyBytes[p]) p++
    }
    e.push({ p, k: keyBytes.subarray(p), v: cur.value, t })
    prevKey = cur.key
  }
  return { l, e }
}

/** Reverse of `serialize`. Children are produced as unloaded Trees that
 *  fault in on demand. The depth we pass in is the depth *of this node* —
 *  every child is at depth + 1 or deeper, but we initialize to depth + 1
 *  because that's the first place we'd look. */
function expandNode(node: MstNode, depth: number, store: BlockStore): NodeEntry[] {
  const out: NodeEntry[] = []
  if (node.l) {
    out.push({ kind: 'tree', tree: Tree.unloaded(node.l, depth + 1, store) })
  }
  let prevKey: string | null = null
  const decoder = new TextDecoder()
  for (const entry of node.e) {
    let key: string
    if (prevKey !== null && entry.p > 0) {
      const prevBytes = new TextEncoder().encode(prevKey)
      const merged = new Uint8Array(entry.p + entry.k.length)
      merged.set(prevBytes.subarray(0, entry.p), 0)
      merged.set(entry.k, entry.p)
      key = decoder.decode(merged)
    } else {
      key = decoder.decode(entry.k)
    }
    out.push({ kind: 'leaf', key, value: entry.v })
    if (entry.t) {
      out.push({ kind: 'tree', tree: Tree.unloaded(entry.t, depth + 1, store) })
    }
    prevKey = key
  }
  return out
}

// ---------- The public MST class ----------

export class MST {
  // The root tree. Note: the root may not be at depth 0 — if every key in
  // the repo has depth >= 1, the root's depth is 1, etc. We track the actual
  // depth so we don't lookup the wrong level.
  private root: Tree
  // Snapshot of CIDs that existed when this MST was loaded/derived. Used by
  // `getRoot()` to compute "blocks new since this MST started".
  private knownCids: Set<string>

  private constructor(root: Tree, knownCids: Set<string>) {
    this.root = root
    this.knownCids = knownCids
  }

  static empty(): MST {
    const root = new Tree({ entries: [], depth: 0, loaded: true })
    return new MST(root, new Set())
  }

  /** Open an existing stored tree by its root CID. */
  static async load(rootCid: CID, store: BlockStore): Promise<MST> {
    // The root depth must be inferred. We can't compute it without seeing
    // the keys, so we read the root node and use its first leaf's depth.
    // If empty, we treat it as depth 0.
    const bytes = await store.getBlock(rootCid)
    if (!bytes) throw new Error(`MST root missing: ${rootCid.toString()}`)
    const node = await decode<MstNode>(bytes, rootCid)
    let depth = 0
    if (node.e.length > 0) {
      // We need the *full* key (after applying prefix compression) of the
      // first leaf to compute its depth.
      const decoder = new TextDecoder()
      const first = node.e[0]!
      const key = decoder.decode(first.k) // p is always 0 for e[0]
      depth = leadingZerosOnHash(key)
    } else if (node.l) {
      // Empty entry list but has a left subtree. This is allowed at the
      // root: it means every key sits below depth 0. We'll discover the
      // true depth lazily on first lookup. Use 0 as a safe starting point.
      depth = 0
    }
    const entries = expandNode(node, depth, store)
    const root = new Tree({
      entries,
      depth,
      store,
      cid: rootCid,
      bytes,
      loaded: true,
    })
    const known = new Set<string>([rootCid.toString()])
    return new MST(root, known)
  }

  /** Look up a key's CID. Returns null if absent. */
  async get(key: string): Promise<CID | null> {
    const keyDepth = leadingZerosOnHash(key)
    let cursor = this.root
    while (true) {
      await cursor.ensureLoaded()
      if (keyDepth > cursor.depth) {
        // Descend through the appropriate subtree.
        const child = findChildForKey(cursor, key)
        if (!child) return null
        cursor = child
        continue
      }
      if (keyDepth < cursor.depth) return null
      // keyDepth === cursor.depth → search this node's leaves.
      for (const entry of cursor.entries) {
        if (entry.kind === 'leaf' && entry.key === key) return entry.value
      }
      return null
    }
  }

  /** Insert a new key. Throws if the key already exists. */
  async add(key: string, value: CID): Promise<MST> {
    const existing = await this.get(key)
    if (existing) throw new Error(`MST.add: key already exists: ${key}`)
    const keyDepth = leadingZerosOnHash(key)
    const newRoot = await insertInto(this.root, key, value, keyDepth)
    const settled = trimRoot(newRoot)
    return new MST(settled, this.knownCids)
  }

  /** Overwrite an existing key. Throws if the key is absent. */
  async update(key: string, value: CID): Promise<MST> {
    const existing = await this.get(key)
    if (!existing) throw new Error(`MST.update: key not found: ${key}`)
    const keyDepth = leadingZerosOnHash(key)
    const newRoot = await updateIn(this.root, key, value, keyDepth)
    return new MST(newRoot, this.knownCids)
  }

  /** Remove a key. Throws if not present. */
  async delete(key: string): Promise<MST> {
    const existing = await this.get(key)
    if (!existing) throw new Error(`MST.delete: key not found: ${key}`)
    const keyDepth = leadingZerosOnHash(key)
    const newRoot = await deleteIn(this.root, key, keyDepth)
    const settled = trimRoot(newRoot)
    return new MST(settled, this.knownCids)
  }

  /** Ordered enumeration of (key, cid) pairs. */
  async *list(opts?: {
    prefix?: string
    limit?: number
    reverse?: boolean
    cursor?: string
  }): AsyncIterable<{ key: string; cid: CID }> {
    const prefix = opts?.prefix
    const limit = opts?.limit
    const reverse = opts?.reverse ?? false
    const cursor = opts?.cursor
    let yielded = 0
    for await (const leaf of walkLeaves(this.root, reverse)) {
      if (prefix && !leaf.key.startsWith(prefix)) {
        // Optimization opportunity: skip whole subtrees. We do the simple
        // thing (filter post-walk) because correctness matters more than
        // speed for now.
        continue
      }
      if (cursor !== undefined) {
        if (!reverse && leaf.key <= cursor) continue
        if (reverse && leaf.key >= cursor) continue
      }
      yield { key: leaf.key, cid: leaf.value }
      yielded++
      if (limit !== undefined && yielded >= limit) return
    }
  }

  /** Serialize the tree and return the root CID plus every block created
   *  since this MST was loaded (i.e. every block the caller still needs
   *  to persist). */
  async getRoot(): Promise<{ cid: CID; blocks: Block[] }> {
    const collected: Block[] = []
    const cid = await this.root.getCid(collected)
    // Filter to blocks not already known to the caller.
    const newBlocks: Block[] = []
    const seen = new Set<string>()
    for (const b of collected) {
      const s = b.cid.toString()
      if (this.knownCids.has(s)) continue
      if (seen.has(s)) continue
      seen.add(s)
      newBlocks.push(b)
    }
    return { cid, blocks: newBlocks }
  }

  /** Diff two MSTs. Returns the set of keys that were added / updated /
   *  removed, plus the blocks the consumer needs to fetch (newBlocks) and
   *  the blocks the consumer can prune (removedCids).
   *
   *  This is a key-level diff, not a block-level diff. The caller decides
   *  how to use it — for example, the firehose ships `newBlocks` and the
   *  key-set for subscribers. */
  static async diff(prev: MST, next: MST): Promise<MstDiff> {
    const adds = new Map<string, CID>()
    const updates = new Map<string, [CID, CID]>()
    const deletes = new Map<string, CID>()

    const prevMap = new Map<string, CID>()
    for await (const e of prev.list()) prevMap.set(e.key, e.cid)
    const nextMap = new Map<string, CID>()
    for await (const e of next.list()) nextMap.set(e.key, e.cid)

    for (const [k, v] of nextMap) {
      const before = prevMap.get(k)
      if (!before) {
        adds.set(k, v)
      } else if (!cidEquals(before, v)) {
        updates.set(k, [before, v])
      }
    }
    for (const [k, v] of prevMap) {
      if (!nextMap.has(k)) deletes.set(k, v)
    }

    const prevBlockSet = await collectAllBlocks(prev.root)
    const nextBlockSet = await collectAllBlocks(next.root)
    const newBlocks: Block[] = []
    const removedCids: CID[] = []
    for (const [s, b] of nextBlockSet) {
      if (!prevBlockSet.has(s)) newBlocks.push(b)
    }
    for (const [s, b] of prevBlockSet) {
      if (!nextBlockSet.has(s)) removedCids.push(b.cid)
    }
    return { adds, updates, deletes, newBlocks, removedCids }
  }
}

// ---------- Tree manipulation ----------

/** Given a node, find which child subtree a key belongs to. Returns null
 *  if the position would lie at an empty pointer. */
function findChildForKey(node: Tree, key: string): Tree | null {
  // Walk leaves in order; the first leaf whose key > our key determines
  // where we descend.
  let priorTree: Tree | null = null
  for (let i = 0; i < node.entries.length; i++) {
    const e = node.entries[i]!
    if (e.kind === 'tree') {
      priorTree = e.tree
      continue
    }
    if (key < e.key) {
      return priorTree
    }
    if (key === e.key) {
      // Caller should have handled "found at this depth" before descending.
      return null
    }
    priorTree = null
    // After a leaf, the next entry (if any) is the right-subtree for keys
    // greater than this leaf. We'll see it next iteration as `tree`.
  }
  // Key is greater than every leaf; descend into the rightmost subtree.
  return priorTree
}

/** Walk leaves in key order across an entire tree (recursing into subtrees). */
async function* walkLeaves(
  tree: Tree,
  reverse: boolean,
): AsyncIterable<Leaf> {
  await tree.ensureLoaded()
  const entries = reverse ? [...tree.entries].reverse() : tree.entries
  for (const e of entries) {
    if (e.kind === 'tree') {
      yield* walkLeaves(e.tree, reverse)
    } else {
      yield e
    }
  }
}

/** Collect every block reachable from this tree, serializing dirty children
 *  along the way. Used by `diff`. */
async function collectAllBlocks(tree: Tree): Promise<Map<string, Block>> {
  const out = new Map<string, Block>()
  async function recurse(t: Tree): Promise<void> {
    await t.ensureLoaded()
    const collected: Block[] = []
    const cid = await t.getCid(collected)
    for (const b of collected) out.set(b.cid.toString(), b)
    // ensure the root block of this subtree is captured even if cached
    if (!out.has(cid.toString())) {
      // Re-encode to recover bytes if needed. In practice getCid pushes
      // to collected when (re)encoding, so this branch only triggers when
      // the tree was loaded from disk and never re-encoded; we have to
      // refetch from store.
      if (t.store) {
        const bytes = await t.store.getBlock(cid)
        if (bytes) out.set(cid.toString(), { cid, bytes })
      }
    }
    for (const e of t.entries) {
      if (e.kind === 'tree') await recurse(e.tree)
    }
  }
  await recurse(tree)
  return out
}

/** Split a tree by `key`: returns (left, right) where left holds entries
 *  with keys < `key` and right holds entries with keys > `key`. The key
 *  itself is assumed not to be in the tree (caller's responsibility). */
async function splitOnKey(
  tree: Tree | null,
  key: string,
): Promise<{ left: Tree | null; right: Tree | null }> {
  if (!tree) return { left: null, right: null }
  await tree.ensureLoaded()
  if (tree.isEmpty()) return { left: null, right: null }

  const leftEntries: NodeEntry[] = []
  const rightEntries: NodeEntry[] = []
  let pivoted = false

  for (let i = 0; i < tree.entries.length; i++) {
    const e = tree.entries[i]!
    if (pivoted) {
      rightEntries.push(e)
      continue
    }
    if (e.kind === 'leaf') {
      if (e.key < key) {
        leftEntries.push(e)
      } else {
        // First entry that lands on the right side.
        pivoted = true
        rightEntries.push(e)
      }
      continue
    }
    // It's a tree pointer. Decide which side it belongs on by looking at
    // the next entry: if the *next* leaf's key is < key, the whole pointer
    // belongs left; if > key, the whole pointer belongs right; if the key
    // would split this subtree, we recurse.
    let nextLeafKey: string | null = null
    for (let j = i + 1; j < tree.entries.length; j++) {
      const candidate = tree.entries[j]!
      if (candidate.kind === 'leaf') {
        nextLeafKey = candidate.key
        break
      }
    }
    if (nextLeafKey !== null && nextLeafKey < key) {
      leftEntries.push(e)
    } else if (nextLeafKey !== null && nextLeafKey > key) {
      // This pointer might still contain keys both above and below `key`.
      // Recurse into it.
      const split = await splitOnKey(e.tree, key)
      if (split.left) leftEntries.push({ kind: 'tree', tree: split.left })
      if (split.right) rightEntries.push({ kind: 'tree', tree: split.right })
      pivoted = true
    } else {
      // No more leaves in this node (this is a trailing pointer). Recurse.
      const split = await splitOnKey(e.tree, key)
      if (split.left) leftEntries.push({ kind: 'tree', tree: split.left })
      if (split.right) rightEntries.push({ kind: 'tree', tree: split.right })
      pivoted = true
    }
  }

  const left = leftEntries.length > 0
    ? new Tree({ entries: leftEntries, depth: tree.depth })
    : null
  const right = rightEntries.length > 0
    ? new Tree({ entries: rightEntries, depth: tree.depth })
    : null
  return { left, right }
}

/** Core insertion. Returns the new tree at the same logical position; the
 *  caller is responsible for rooting it. */
async function insertInto(
  node: Tree,
  key: string,
  value: CID,
  keyDepth: number,
): Promise<Tree> {
  await node.ensureLoaded()

  // Case A: node sits exactly at keyDepth → leaf goes in here.
  if (node.depth === keyDepth) {
    return insertLeafIntoNode(node, key, value)
  }

  // Case B: node sits deeper than keyDepth → the new leaf belongs to an
  // ancestor we don't have yet. Wrap into a new parent at keyDepth, then
  // insert there.
  if (node.depth > keyDepth) {
    const split = await splitOnKey(node, key)
    const newRoot = new Tree({ entries: [], depth: keyDepth })
    if (split.left && !split.left.isEmpty()) {
      newRoot.entries.push({ kind: 'tree', tree: split.left })
    }
    newRoot.entries.push({ kind: 'leaf', key, value })
    if (split.right && !split.right.isEmpty()) {
      newRoot.entries.push({ kind: 'tree', tree: split.right })
    }
    newRoot.markDirty()
    return newRoot
  }

  // Case C: node sits shallower than keyDepth → descend into the correct
  // child, creating an empty one if necessary.
  return insertInChild(node, key, value, keyDepth)
}

async function insertLeafIntoNode(
  node: Tree,
  key: string,
  value: CID,
): Promise<Tree> {
  // Find the position where the leaf belongs in the entries list.
  const newEntries: NodeEntry[] = []
  let inserted = false
  let i = 0
  while (i < node.entries.length) {
    const e = node.entries[i]!
    if (e.kind === 'leaf') {
      if (!inserted && key < e.key) {
        newEntries.push({ kind: 'leaf', key, value })
        inserted = true
      }
      newEntries.push(e)
      i++
      continue
    }
    // It's a tree pointer. Decide whether the new key falls before this
    // pointer's range, inside it, or after it.
    const prevLeafKey = lastLeafKeyOf(newEntries) // largest key already placed
    let nextLeafKey: string | null = null
    for (let j = i + 1; j < node.entries.length; j++) {
      const c = node.entries[j]!
      if (c.kind === 'leaf') {
        nextLeafKey = c.key
        break
      }
    }
    const lowerOk = prevLeafKey === null || prevLeafKey < key
    const upperOk = nextLeafKey === null || key < nextLeafKey
    if (!inserted && lowerOk && upperOk) {
      // The key sits in this subtree's range → split it.
      const split = await splitOnKey(e.tree, key)
      if (split.left && !split.left.isEmpty()) {
        newEntries.push({ kind: 'tree', tree: split.left })
      }
      newEntries.push({ kind: 'leaf', key, value })
      if (split.right && !split.right.isEmpty()) {
        newEntries.push({ kind: 'tree', tree: split.right })
      }
      inserted = true
      i++
      continue
    }
    newEntries.push(e)
    i++
  }
  if (!inserted) newEntries.push({ kind: 'leaf', key, value })
  return new Tree({
    entries: newEntries,
    depth: node.depth,
  })
}

function lastLeafKeyOf(entries: NodeEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'leaf') return e.key
  }
  return null
}

async function insertInChild(
  node: Tree,
  key: string,
  value: CID,
  keyDepth: number,
): Promise<Tree> {
  // Find the child slot the key descends into. We rebuild the entries list
  // and replace one tree pointer (or create one between two leaves).
  const newEntries: NodeEntry[] = []
  let handled = false

  for (let i = 0; i < node.entries.length; i++) {
    const e = node.entries[i]!
    if (handled || e.kind === 'leaf') {
      // Before we copy a leaf, decide if the new key belongs in the slot
      // immediately before it.
      if (!handled && e.kind === 'leaf' && key < e.key) {
        // The slot just before this leaf is either an existing tree
        // pointer (already copied to newEntries) or an empty slot.
        const last = newEntries[newEntries.length - 1]
        if (last && last.kind === 'tree') {
          // Replace the pointer with an inserted version.
          newEntries[newEntries.length - 1] = {
            kind: 'tree',
            tree: await insertInto(last.tree, key, value, keyDepth),
          }
        } else {
          // No subtree existed at this slot; create one at depth+1.
          const child = new Tree({ entries: [], depth: node.depth + 1 })
          newEntries.push({
            kind: 'tree',
            tree: await insertInto(child, key, value, keyDepth),
          })
        }
        handled = true
      }
      newEntries.push(e)
      continue
    }
    // Tree pointer. We'll keep it for now; the next iteration might decide
    // to merge into it.
    newEntries.push(e)
  }

  if (!handled) {
    // The key is greater than every leaf — descends into the rightmost
    // subtree (or a newly-created one).
    const last = newEntries[newEntries.length - 1]
    if (last && last.kind === 'tree') {
      newEntries[newEntries.length - 1] = {
        kind: 'tree',
        tree: await insertInto(last.tree, key, value, keyDepth),
      }
    } else {
      const child = new Tree({ entries: [], depth: node.depth + 1 })
      newEntries.push({
        kind: 'tree',
        tree: await insertInto(child, key, value, keyDepth),
      })
    }
  }
  return new Tree({ entries: newEntries, depth: node.depth })
}

async function updateIn(
  node: Tree,
  key: string,
  value: CID,
  keyDepth: number,
): Promise<Tree> {
  await node.ensureLoaded()
  if (node.depth === keyDepth) {
    const newEntries = node.entries.map((e) =>
      e.kind === 'leaf' && e.key === key
        ? ({ kind: 'leaf', key, value } as NodeEntry)
        : e,
    )
    return new Tree({ entries: newEntries, depth: node.depth })
  }
  // Descend into the child the key belongs to.
  const newEntries: NodeEntry[] = []
  let updated = false
  let lastSlotIdx = -1
  for (let i = 0; i < node.entries.length; i++) {
    const e = node.entries[i]!
    newEntries.push(e)
    if (e.kind === 'tree') {
      const next = node.entries[i + 1]
      const prev = i > 0 ? node.entries[i - 1] : null
      const lowerOk =
        !prev || prev.kind !== 'leaf' || prev.key < key
      const upperOk =
        !next || next.kind !== 'leaf' || key < next.key
      if (!updated && lowerOk && upperOk) {
        newEntries[newEntries.length - 1] = {
          kind: 'tree',
          tree: await updateIn(e.tree, key, value, keyDepth),
        }
        updated = true
      } else {
        lastSlotIdx = newEntries.length - 1
      }
    }
  }
  if (!updated && lastSlotIdx >= 0) {
    // Fallback: update through the last seen pointer (shouldn't happen if
    // get() said the key exists).
    const target = newEntries[lastSlotIdx]! as Pointer
    newEntries[lastSlotIdx] = {
      kind: 'tree',
      tree: await updateIn(target.tree, key, value, keyDepth),
    }
  }
  return new Tree({ entries: newEntries, depth: node.depth })
}

async function deleteIn(
  node: Tree,
  key: string,
  keyDepth: number,
): Promise<Tree> {
  await node.ensureLoaded()
  if (node.depth === keyDepth) {
    return await deleteLeafFromNode(node, key)
  }
  // Descend.
  const newEntries: NodeEntry[] = [...node.entries]
  for (let i = 0; i < newEntries.length; i++) {
    const e = newEntries[i]!
    if (e.kind !== 'tree') continue
    const prev = i > 0 ? newEntries[i - 1] : null
    const next = i + 1 < newEntries.length ? newEntries[i + 1] : null
    const lowerOk = !prev || prev.kind !== 'leaf' || prev.key < key
    const upperOk = !next || next.kind !== 'leaf' || key < next.key
    if (lowerOk && upperOk) {
      const newChild = await deleteIn(e.tree, key, keyDepth)
      await newChild.ensureLoaded()
      if (newChild.isEmpty()) {
        newEntries.splice(i, 1)
        // Two adjacent leaves might now meet — that's fine, no merge needed.
        break
      } else {
        newEntries[i] = { kind: 'tree', tree: newChild }
        break
      }
    }
  }
  return new Tree({ entries: newEntries, depth: node.depth })
}

async function deleteLeafFromNode(node: Tree, key: string): Promise<Tree> {
  const newEntries: NodeEntry[] = []
  let i = 0
  while (i < node.entries.length) {
    const e = node.entries[i]!
    if (e.kind === 'leaf' && e.key === key) {
      // The slot of `e` may have a tree pointer immediately before AND
      // after it. If so, we need to merge them into a single subtree.
      const before = newEntries[newEntries.length - 1]
      const after = node.entries[i + 1]
      if (
        before &&
        before.kind === 'tree' &&
        after &&
        after.kind === 'tree'
      ) {
        // Merge: left subtree's keys are all < removed.key, right's all >.
        // They sit at the same depth, so concatenate their entries.
        await before.tree.ensureLoaded()
        await after.tree.ensureLoaded()
        const merged = new Tree({
          entries: [...before.tree.entries, ...after.tree.entries],
          depth: before.tree.depth,
        })
        newEntries[newEntries.length - 1] = { kind: 'tree', tree: merged }
        i += 2 // skip the leaf AND the after-pointer
        continue
      }
      // Only one or neither side has a pointer — just drop the leaf.
      i += 1
      continue
    }
    newEntries.push(e)
    i++
  }
  return new Tree({ entries: newEntries, depth: node.depth })
}

/** If the root has a single child pointer and no leaves, demote: the child
 *  becomes the new root. We may repeat until the root has at least one leaf
 *  or is empty. */
function trimRoot(tree: Tree): Tree {
  let cur = tree
  while (true) {
    if (cur.entries.length === 1) {
      const only = cur.entries[0]!
      if (only.kind === 'tree') {
        cur = only.tree
        continue
      }
    }
    return cur
  }
}

// ---------- Backward-compat: keep `emptyMst` working ----------

/** Build the empty MST root and return its block. Preserved for existing
 *  callers (account creation lands the empty root via this). */
export async function emptyMst(): Promise<Block> {
  const node: MstNode = { l: null, e: [] }
  return await encode(node)
}

// ---------- Self-test ----------

/** Smoke-test the implementation end-to-end. Throws on the first failure;
 *  returns silently on success. */
export async function runMstSelfTest(): Promise<void> {
  const { cidForBytes } = await import('~/pds/codec')
  const rng = mulberry32(0x12345678)

  // 1. Build an empty MST.
  let mst = MST.empty()

  // 2. Insert 100 random keys with random CID values.
  const keys: string[] = []
  const values = new Map<string, CID>()
  for (let i = 0; i < 100; i++) {
    const key = `app.bsky.feed.post/${randString(rng, 13)}`
    const valBytes = randBytes(rng, 32)
    const cid = await cidForBytes(valBytes)
    keys.push(key)
    values.set(key, cid)
    mst = await mst.add(key, cid)
  }

  // 3. Verify get() returns the same CID.
  for (const k of keys) {
    const got = await mst.get(k)
    if (!got) throw new Error(`selftest: missing key ${k}`)
    const want = values.get(k)!
    if (!cidEquals(got, want)) {
      throw new Error(`selftest: wrong CID for ${k}`)
    }
  }

  // 4. Delete half.
  const toDelete = keys.slice(0, 50)
  const surviving = keys.slice(50)
  for (const k of toDelete) mst = await mst.delete(k)

  // 5. Verify remaining and deleted.
  for (const k of toDelete) {
    const got = await mst.get(k)
    if (got !== null) throw new Error(`selftest: ghost key ${k}`)
  }
  for (const k of surviving) {
    const got = await mst.get(k)
    if (!got) throw new Error(`selftest: lost surviving key ${k}`)
    if (!cidEquals(got, values.get(k)!)) {
      throw new Error(`selftest: wrong CID for surviving ${k}`)
    }
  }

  // 6. Determinism: build a fresh MST 5 times with shuffled insertion orders
  //    and confirm the root CID is identical.
  const fullKeys = [...keys]
  let referenceRoot: CID | null = null
  for (let shuffle = 0; shuffle < 5; shuffle++) {
    const shuffled = shuffleCopy(fullKeys, mulberry32(0x10000 + shuffle))
    let m = MST.empty()
    for (const k of shuffled) {
      m = await m.add(k, values.get(k)!)
    }
    const { cid } = await m.getRoot()
    if (referenceRoot === null) {
      referenceRoot = cid
    } else if (!cidEquals(referenceRoot, cid)) {
      throw new Error(
        `selftest: nondeterministic root — shuffle ${shuffle} produced ${cid.toString()} vs ${referenceRoot.toString()}`,
      )
    }
  }

  // 7. Bonus: diff between empty and full tree should equal the key set.
  const full = (async () => {
    let m = MST.empty()
    for (const k of fullKeys) m = await m.add(k, values.get(k)!)
    return m
  })
  const f = await full()
  const diff = await MST.diff(MST.empty(), f)
  if (diff.adds.size !== fullKeys.length) {
    throw new Error(
      `selftest: diff adds = ${diff.adds.size}, want ${fullKeys.length}`,
    )
  }
  if (diff.deletes.size !== 0 || diff.updates.size !== 0) {
    throw new Error('selftest: spurious diff entries')
  }

  // eslint-disable-next-line no-console
  console.log('MST self-test passed:', {
    keys: keys.length,
    surviving: surviving.length,
    referenceRoot: referenceRoot?.toString() ?? null,
    diffAdds: diff.adds.size,
    diffNewBlocks: diff.newBlocks.length,
  })
}

// ---------- Test utilities (no external dep) ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randString(rng: () => number, n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let s = ''
  for (let i = 0; i < n; i++) {
    s += alphabet[Math.floor(rng() * alphabet.length)]
  }
  return s
}

function randBytes(rng: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256)
  return out
}

function shuffleCopy<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}
