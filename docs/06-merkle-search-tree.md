# Merkle Search Trees

This is the chapter that pays for the rest of the book. The Merkle Search
Tree (MST) is the data structure at the heart of every AT Protocol repository,
and once you understand it, everything else — commits, CAR diffs, the
firehose — clicks into place.

## What problem are we solving?

A repository holds many records, keyed by a string path (`<collection>/<rkey>`).
We need a data structure that:

1. Maps paths to record CIDs.
2. Is **content-addressed**: every node has a CID, so we can hash the whole
   tree to one 36-byte root.
3. Is **deterministic**: the same set of paths always produces the same
   tree shape, regardless of insertion order. (Otherwise two PDSes
   replicating the same data would compute different root CIDs.)
4. Diffs efficiently: given two roots, we can enumerate the changed paths
   without walking every record.
5. Scales to hundreds of thousands of records per repo without keeping
   them all in memory.

A regular hash map is content-addressable but doesn't diff well — insert
one record and the whole map's hash changes. A B-tree diffs well but isn't
deterministic — different insertion orders produce different tree shapes.

The MST, [introduced by Auvolat & Taïani in 2019](https://hal.inria.fr/hal-02303490),
hits all five points. It's a probabilistic balanced search tree where each
key's depth is **derived from its hash**, not from the order it was inserted.

## The shape of an MST

An MST is a tree of **nodes**. Each node holds an ordered list of entries.
An entry is either:

- A `(key, value-cid)` pair, OR
- A pointer to a child node (another CID).

Critically, entries can be *interleaved*: a node can be
`[ptr, leaf, ptr, leaf, ptr]`. The pointers between leaves are the subtrees
whose keys fall between those leaves' keys.

Picture a node holding keys `b, d, f`:

```
              ┌─────────────────────────────────────────┐
              │ [ptr0]  b → cidB  [ptr1]  d → cidD  [ptr2]  f → cidF  [ptr3] │
              └─┬─────────────────┬─────────────────────┬─────────────────┬───┘
                │                 │                     │                 │
                ▼                 ▼                     ▼                 ▼
              keys < b      keys in (b, d)       keys in (d, f)        keys > f
```

The pointers between entries cover the open intervals between keys.
Anything ≤ "b" but not equal to "b" lives in the leftmost subtree; anything
between "b" and "d" (exclusive both ends) lives in the next; etc.

## What decides a key's depth?

This is the trick that makes the structure deterministic. Every key gets
hashed with SHA-256, and its **depth in the tree** is the count of leading
zero bytes in the hash — multiplied by some scaling factor, but conceptually:

- Hash starts with no leading zeros → depth 0 (leaves at the root).
- Hash starts with one leading zero byte → depth 1 (one node down).
- Hash starts with two leading zeros → depth 2.

The result: any given key has a *fixed* depth across all possible MSTs that
might contain it. Different repos that happen to share a key will place it
at the same level.

The expected branching factor depends on the byte-comparison threshold the
spec picks. The AT Protocol uses **base-16 (one nibble) per depth level**:

- Depth 0: ~15/16 of keys (most).
- Depth 1: ~1/16 of keys.
- Depth 2: ~1/256.
- And so on.

So an MST with a million keys is expected to be ~5 levels deep. Cheap to
walk, cheap to diff.

> **In code:** `leadingZerosOnHash(key)` in `src/pds/repo/mst.ts` counts
> leading zero hex characters of the SHA-256 hash. So a hash whose first
> nibble is non-zero gives depth 0; one starting with `0a…` gives depth 1;
> one starting with `00a…` gives depth 2; one starting with `000a…` gives
> depth 3.

## Inserting a key

To insert `(key, value)`:

1. Compute `depth = leadingZeros(sha256(key))`.
2. Walk from the root to that depth, taking the appropriate child pointer
   at each level.
3. At the destination node, find the position where `key` fits in the
   sorted entry list.
4. Insert the entry. If it splits a pointer into two (because `key` lies
   between two existing keys, and the subtree under that pointer was
   non-empty), split the subtree's keys on `key`.
5. Walk back up, recomputing each affected node's CID.

The walk-back-up step is what makes the root CID change with every write.
You change one leaf; the root changes; every node on the path between
changes too. But the node count along that path is O(log n), so the
amortized cost per write is small.

## Deleting a key

Mirror image of insert:

1. Find the entry at its expected depth.
2. Remove it.
3. If removing it left two adjacent subtree pointers, **merge** them — the
   keys that used to be split by the deleted key now belong in a single
   subtree.
4. Walk back up, recomputing CIDs.

## Looking up a key

Easy:

1. Hash the key, compute its depth.
2. Descend to that depth, choosing the right child at each level.
3. Look for the key in the destination node's entries.
4. If present: return its CID. If not: the key doesn't exist.

Lookup is O(depth) = O(log n).

## Diffing two roots

The MST's killer feature. Given two root CIDs:

1. If they're equal, the trees are identical. Done.
2. If they differ, fetch both root nodes.
3. Walk them in parallel, comparing entries:
   - Equal CIDs in matching positions → that subtree is unchanged, skip it.
   - Different CIDs → recurse into both subtrees.
   - Entry exists on one side but not the other → it was added or removed.
4. The leaves you hit are the changed records; the entire set of differing
   blocks (leaves + every internal node on the path) is the firehose
   "changed blocks" payload.

This is why the firehose can stream just the diff per commit instead of
re-sending the whole repo on every write. The diff is *implicit in the
hashing*.

## How blocks become bytes

When we serialize an MST node to a block, the DAG-CBOR representation
follows the [official MST spec layout](https://atproto.com/specs/repository#mst-data-structure):

```ts
type MstNode = {
  l: CID | null              // left pointer (subtree to the left of e[0])
  e: Array<{
    p: number                // prefix length shared with previous key in this node
    k: Uint8Array            // remainder of the key (after the prefix)
    v: CID                   // value CID for this key
    t: CID | null            // right pointer (subtree to the right of this entry)
  }>
}
```

Two compression tricks worth knowing about:

1. **Prefix compression.** Keys within a node share a common prefix; we only
   store the diff. So a node containing `app.bsky.feed.post/3jzfgg…` and
   `app.bsky.feed.post/3jzfgg2k…` only stores the prefix once.
2. **Implicit "rightmost" pointer.** Each entry carries its *own* right
   pointer (`t`). There's no separate "all-the-rest" pointer at the end of
   the node — the last entry's `t` is the rightmost subtree. The leftmost
   subtree is the explicit `l` field at the top.

When we encode and CID an MST node we use the codec module from
[Chapter 05](./05-cid-and-dagcbor.md). Determinism is what makes the whole
thing work: a given logical tree shape always produces the same bytes.

## How big does this get?

Some napkin math for a Bluesky account with ~10k posts and ~1k follows:

- 11k leaves.
- log_16(11000) ≈ 3.4, so depth 3–4.
- ~700 internal nodes at depth 1, ~40 at depth 2, ~3 at depth 3.
- Each internal node is a few hundred bytes after compression.
- Total MST overhead: ~500 KB.

That's *generous*. A commit ships the new root + every block that changed.
For a single-post write, that's 1 leaf + ~4 internal nodes ≈ 1 KB of CAR
data on the firehose. Cheap.

---

## The implementation

`src/pds/repo/mst.ts` exposes:

```ts
export class MST {
  static empty(): MST
  static load(rootCid: CID, store: BlockStore): Promise<MST>
  static diff(prev: MST, next: MST): Promise<MstDiff>

  get(key: string): Promise<CID | null>
  add(key: string, value: CID): Promise<MST>
  update(key: string, value: CID): Promise<MST>
  delete(key: string): Promise<MST>
  list(opts?: { prefix?; limit?; reverse?; cursor? }): AsyncIterable<{ key, cid }>
  getRoot(): Promise<{ cid: CID; blocks: Block[] }>
}
```

Every mutating method returns a **new** `MST` — the old one is unchanged.
We rebuild the path on every write anyway, so this immutability is free.

`BlockStore` is a one-method interface (`getBlock(cid) → bytes | null`).
The MST module never touches the database directly; the caller wires up
whatever store they want. That makes the module pure and testable.

### Internal node representation

The on-wire shape (`l: CID | null`, `e: Array<{p, k, v, t}>`) is awkward to
manipulate directly. The right-subtree pointer is glued onto its
predecessor leaf, which means inserting a new leaf in the middle of a node
forces you to re-glue pointers to different leaves.

Internally we use a flat interleaved list:

```ts
type NodeEntry = Leaf | Pointer
type Leaf    = { kind: 'leaf';    key: string; value: CID }
type Pointer = { kind: 'tree';    tree: Tree }
```

So the node `[ptr0, b→cidB, ptr1, d→cidD, ptr2]` is just an array of five
entries. Inserting a leaf becomes "splice it into the right slot"; merging
two pointers after a delete becomes "concatenate two entry arrays".
`serialize()` walks this list and emits the `{ l, e }` shape; `expandNode()`
does the reverse on load.

`Tree` is a tiny wrapper that caches its CID + bytes once computed, and
faults itself in from the `BlockStore` on first access. Crucially, when a
mutation copies an unchanged child pointer, the underlying `Tree` is reused
— so `getCid()` returns the cached CID without re-encoding. That's how we
get the "only touched blocks come back as new" property: untouched nodes
are never even decoded, much less re-encoded.

### `add` walks the depth, splitting on the way down

The `add` flow has three cases, matched by the current node's depth vs. the
new key's target depth:

1. **`node.depth === keyDepth`** — the leaf belongs in this node. Find the
   correct sorted position. If a subtree pointer sits in that position
   (because the new key falls between two existing leaves), call
   `splitOnKey(subtree, key)` — keys < `key` stay on the left, keys > `key`
   move to the right, and the new leaf goes between them.
2. **`node.depth > keyDepth`** — the new key is shallower than every key
   currently in the tree under this branch. Split the whole subtree on
   `key`, then build a new parent node at `keyDepth` containing the left
   half, the new leaf, and the right half.
3. **`node.depth < keyDepth`** — the new key sits deeper. Find the child
   subtree the key would descend into, create one if it doesn't exist, and
   recurse.

The splitting step is the only subtle bit. When you insert a key
between two existing leaves, the subtree pointer that *used to* mean "all
keys in this open interval" now needs to be cleaved: keys less than the
new one stay on the left, the rest go on the right. `splitOnKey` handles
this recursively — when the pivot lands inside a sub-pointer's range, it
descends and splits the deeper node too.

> ⚠️ **Divergence from upstream.** The reference Bluesky implementation
> separately encodes "insert above current depth" by repeatedly wrapping
> the existing root in a single-pointer parent until depths line up. We
> just call `splitOnKey` on the whole subtree once and build the new
> parent. Both approaches produce the same tree (the spec is unambiguous);
> ours is a few fewer lines.

### `delete` walks down to the leaf, then merges

The mirror of insert. We find the leaf at its target depth and remove it
from the entry list. The interesting case is when the removed leaf sat
*between* two subtree pointers. Before deletion the picture was
`[…, ptrA, leaf, ptrB, …]`; after, it's `[…, ptrA, ptrB, …]` — two
adjacent pointers, which isn't a valid node shape.

We fix it by **merging**: load both subtrees, concatenate their entry
lists (left's entries come first, since all its keys are < the deleted
key, and all of right's keys are >), and replace the two pointers with one
pointer to the merged tree.

Empty subtrees get pruned on the way up: if a subtree becomes empty after
delete, its pointer drops out of the parent's entry list entirely (the
spec says "empty subtrees are encoded as null pointers, not empty nodes").

After every mutation, `trimRoot()` checks whether the root has collapsed
to a single child pointer with no leaves of its own. If so, the child
becomes the new root — this is **depth demotion**, the opposite of the
wrap-in-a-new-parent we do in `add` case 2.

### `update` is `delete + add`'s simpler cousin

`update` walks down the same descent path as `get`, finds the matching
leaf at its target depth, and replaces just the value CID. Tree shape
doesn't change, so no splits and no merges are needed. The path's nodes
above all get re-encoded (because their child CIDs changed), but their
*entry lists* don't change at all.

### `getRoot` returns "blocks new since load"

When we call `getRoot()` on a freshly-mutated MST, we want to know which
blocks the caller needs to persist. The trick: every `Tree` knows whether
its CID has been invalidated. We walk the tree, encoding only dirty nodes,
and collect every block we emit. We also keep a `knownCids` set populated
when the MST was loaded (containing the root CID we started from). Blocks
in `knownCids` get filtered out of the returned list, so the caller only
sees *truly new* blocks.

If you call `getRoot()` on an unchanged loaded MST, you get the root CID
and an empty `blocks` array. Useful: callers can use it as a "what
changed?" probe without paying for serialization.

### `diff` works at the key set level

`MST.diff(prev, next)` returns four maps and arrays:

- `adds`: keys present in `next` but not `prev`
- `updates`: keys whose CID changed
- `deletes`: keys gone from `prev`
- `newBlocks`: every block reachable from `next` that isn't reachable from `prev`
- `removedCids`: every CID reachable from `prev` that isn't reachable from `next`

The implementation is intentionally simple: list both trees, take set
differences. A smarter implementation walks the trees in parallel and
prunes subtrees whose root CIDs match — but the set-diff is easy to
audit and the trees are typically a few hundred blocks. We can swap in a
walker later without changing the API.

> 📖 **Why expose both the key diff and the block diff?**
> The firehose payload needs the block diff (CAR file of new blocks +
> root CID). Application code generally only cares about the key diff
> (which records were added/changed/deleted). Returning both costs one
> map walk and saves callers from re-deriving one from the other.

### Determinism, restated

The hardest property to keep is also the most important: **insertion order
must not affect the resulting CID**. Two facts protect this:

1. A key's depth is fixed by its hash — it can't drift between depths
   based on what else is in the tree.
2. Within a node, entries are stored in sorted key order — the encoder
   always emits them in the same sequence.

The self-test below builds the same key set five times in five different
random orders and confirms all five roots are equal. If you change the
algorithm and that test starts failing, you've broken protocol-level
replication. There is no "good enough" here.

---

## Try it

The implementation ships with a self-test:

```bash
pnpm tsx -e "await import('./src/pds/repo/mst').then(m => m.runMstSelfTest())"
```

Or, equivalently in an `.mts` file:

```ts
import { runMstSelfTest } from './src/pds/repo/mst.ts'
await runMstSelfTest()
```

What it proves:

- **100 inserts + 100 lookups round-trip.** Every `add()` produces a tree
  that `get()` can read.
- **Delete works.** After removing 50 of the 100 keys, the survivors still
  resolve and the deleted ones return `null`.
- **Determinism.** Builds the full 100-key set five times in five
  different shuffled orders. All five must produce the same root CID.
- **Diff is correct.** Diffing empty against full gives exactly 100 adds,
  zero updates, zero deletes.

You should see output like:

```
MST self-test passed: {
  keys: 100,
  surviving: 50,
  referenceRoot: 'bafyreif…',
  diffAdds: 100,
  diffNewBlocks: 5
}
```

If the `referenceRoot` ever differs between runs of the same code, that's
the bug to chase first.

> 📖 **What about a "real" test suite?**
> The project doesn't have one configured yet — `vitest` will land with
> the chapter on testing infrastructure. The exported self-test is a
> deliberate placeholder: it's fast, it has no dependencies, and it'll
> survive the migration into proper unit tests.

## Exercises

1. Why does the MST need the *prev* key's prefix length (`p` field) for
   each entry instead of just storing the full key? Compute the space
   savings for a collection of TIDs that share a 9-byte prefix.
2. What happens to the tree shape if you insert a billion keys whose
   hashes all happen to start with `0x00`? (This won't happen by accident
   — SHA-256 is uniform — but reasoning about it teaches you what's load-
   bearing about the depth derivation.)
3. Given two MST roots, what's the minimum number of blocks you'd need to
   fetch to know whether the trees are *identical* without comparing
   their entries?
4. The `splitOnKey` helper recurses when the pivot key falls inside a
   subtree pointer's range. Sketch a tree where this recursion goes more
   than one level deep, and check by hand that the resulting halves
   reassemble correctly.
5. `delete` merges two adjacent subtree pointers by concatenating their
   entry lists. Convince yourself this is safe — i.e. the concatenated
   list still satisfies the "keys sorted, depth uniform" invariant.
   What would break if the two subtrees were at *different* depths?
6. Write a benchmark that times `add` against a tree of increasing size
   (1k, 10k, 100k keys). Plot the per-write cost. It should look
   logarithmic; if it looks linear, find the bug.
7. Implement `MST.diff` as a parallel tree-walk that prunes matching-CID
   subtrees, and compare its block-fetch count to the current list-based
   implementation for a 10k-key tree with 10 mutations.

## Up next

We have a deterministic tree. Now we wrap it in a signed envelope and call
it a commit: [Chapter 07 — Commits and signing](./07-commits-and-signing.md).

← [05 — CIDs and DAG-CBOR](./05-cid-and-dagcbor.md) · → [07 — Commits and signing](./07-commits-and-signing.md)
