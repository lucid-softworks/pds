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

- Depth 0: ~16/16 of keys (most).
- Depth 1: ~1/16 of keys.
- Depth 2: ~1/256.
- And so on.

So an MST with a million keys is expected to be ~5 levels deep. Cheap to
walk, cheap to diff.

> **In code:** the `leadingZerosOnHash(key)` function in
> `src/pds/repo/mst.ts` (lands with this chapter's session) counts leading
> zeros divided by 4. So a hash whose first nibble is `0` gives depth 1; a
> hash whose first byte is `0x00` gives depth 2.

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

## Where the implementation will live

`src/pds/repo/mst.ts` will hold the algorithm. The shape we're targeting:

```ts
export class MST {
  // Construction
  static empty(): MST
  static load(rootCid: CID, store: BlockStore): MST
  
  // Reading
  async get(key: string): Promise<CID | null>
  async list(prefix: string, opts?: { limit?: number; after?: string }): AsyncIterable<{ key: string; cid: CID }>
  
  // Writing — returns a *new* MST; the old one is unchanged.
  async add(key: string, value: CID): Promise<MST>
  async update(key: string, value: CID): Promise<MST>
  async delete(key: string): Promise<MST>
  
  // Persistence
  async root(): Promise<{ cid: CID; blocks: Block[] }>
  
  // Diff
  static async diff(prev: MST, next: MST): Promise<MstDiff>
}
```

It's immutable: every write returns a new MST handle. That mirrors how the
underlying tree works (because we're rebuilding the path on every write
anyway, mutating in place gains nothing).

## Try it

Once the implementation lands:

```bash
pnpm tsx scripts/mst-demo.ts
```

…will build an MST with a thousand keys, print its depth distribution, then
add one key and show which blocks changed. You should see ~5 blocks
touched, not 1,000.

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

## Up next

We have a deterministic tree. Now we wrap it in a signed envelope and call
it a commit: [Chapter 07 — Commits and signing](./07-commits-and-signing.md).
