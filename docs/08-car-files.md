# CAR files

By chapter 07 every block in the repository is content-addressed: a chunk
of DAG-CBOR bytes pinned by a CID, sitting in `repo_blocks`. The question
this chapter answers is: **how do those blocks get out of the database and
onto the wire?**

The answer is [CAR (Content Addressable aRchives)](https://ipld.io/specs/transport/car/),
specifically CAR v1. CAR is the envelope every repo export and every
firehose commit ships in. It's almost embarrassingly simple — twelve lines
of spec, no schema versions, no framing tricks — and that simplicity is
the whole point.

## The wire format

A CAR v1 file is exactly this:

```
+-------------------------------+
| varint(header_length)         |
+-------------------------------+
| DAG-CBOR(header)              |
|   { version: 1, roots: [CID] }|
+-------------------------------+
| Block 0:                      |
|   varint(block_length)        |
|   CID bytes                   |
|   block bytes                 |
+-------------------------------+
| Block 1: ...                  |
+-------------------------------+
| ...                           |
+-------------------------------+
```

Where `block_length = len(CID bytes) + len(block bytes)`. The varints are
unsigned LEB128: 7 payload bits per byte plus a "more bytes follow"
continuation bit in the top position. The header is a one-key map (well,
two: `version` and `roots`) encoded with the same DAG-CBOR rules we already
use everywhere else.

CIDs in CAR files are written as **raw bytes**, not multibase strings. So a
CIDv1 inside a CAR is:

```
01 71 12 20 <32 hash bytes>
└┘ └┘ └┘ └┘ └────────────┘
v1 dag- sha 32  the digest
   cbor 256 bytes
```

That's 36 bytes flat for every CID we produce. Hold onto that number — it
shows up in the decoder.

### A worked example

Here's a tiny CAR built in our head. One root, one block. The block is
`{ "hi": "earth" }` encoded as DAG-CBOR (12 bytes), whose CID is some
sha256 we'll call `bafyrei…ABCD`. The CAR bytes:

```
1f                          # varint: header is 31 bytes long
a2                          # cbor map of 2 pairs
  65 72 6f 6f 74 73         # "roots" (5 bytes)
  81                        # array of 1
    d8 2a                   # tag 42 (cid-link)
    58 25                   # byte string of 37 bytes
      00 01 71 12 20 <32B>  # cid bytes with leading 0x00 multibase marker
  67 76 65 72 73 69 6f 6e   # "version" (7 bytes)
  01                        # integer 1
30                          # varint: next block is 48 bytes long
  01 71 12 20 <32B>         # cid bytes (36)
  a1                        # cbor map of 1 pair
  62 68 69                  # "hi"
  65 65 61 72 74 68         # "earth"
```

The framing is so light that "reading a CAR" and "calling `splice` until you
run out of input" are essentially the same operation.

> 📖 The `00` before `01 71 12 20…` inside the DAG-CBOR header is the
> multibase **identity prefix** (raw bytes). The CID tag's payload is a
> multibase-encoded byte string, and identity is the only multibase that
> makes sense inside CBOR — adding base32 text would defeat the point. So
> CIDs-inside-CBOR are always `0x00` followed by the raw CID bytes, while
> CIDs-inside-CAR-block-framing are *just* the raw CID bytes with no
> prefix. Two different conventions, one byte apart.

## Why this design

The structure is just `varint || header || (varint || cid || bytes)*`.
Three properties drop out of that:

1. **Streamable.** A reader needs no lookahead. Read a varint, read that
   many bytes, decide what to do, repeat. The producer can yield bytes
   the moment they're ready; the consumer can act on each block before
   the next one arrives.
2. **Self-delimiting.** No escape sequences, no end markers. The varint
   tells you how many bytes are in the next chunk; you read exactly that
   many. There's no parsing state to confuse, no "did this byte mean the
   end of the block or the literal value of the next byte?" ambiguity.
3. **Verifiable per-block.** Every block carries its CID inline. The
   consumer can SHA-256 the bytes and compare to the CID's multihash
   before doing anything else with them. A tampered byte in block 47
   doesn't poison the consumer's view of blocks 0–46.

This is the same trick git uses internally for packfiles, with a different
hash and codec. The idea travels.

## Two uses in the PDS

### Full export — `com.atproto.sync.getRepo`

The response body is **the entire repository** as one CAR:

- `roots = [<current signed-commit CID>]`
- Blocks are every block reachable from that commit: the commit itself,
  the MST root, every MST internal node, every leaf record block.

A consumer (a relay, an archiver, a user pulling a backup) walks the
blocks, hash-verifies each one, drops them into a local blockstore keyed
by CID, then loads the root and traverses. By the time it's done it has a
byte-for-byte identical copy of the repo.

### Commit diff — firehose `#commit` events

The firehose sends a CAR with **just the blocks that changed in this
commit**:

- `roots = [<new signed-commit CID>]`
- Blocks: the new commit, new MST nodes from root to the changed leaves,
  the new leaf records themselves. Possibly only a handful of blocks.

Same shape, different contents. The consumer applies the diff against the
state it already has, ending up at the new root.

> ⚠️ In both cases the `roots` array is **always a single CID** — the
> current signed-commit CID. The CAR spec allows multiple roots, but the
> AT Protocol nails it down to one. Reject CARs with `roots.length !== 1`
> when ingesting; produce exactly one root when emitting.

## Streaming and verification

The decoder's job has two parts: parse the framing and **verify each
block**.

The verification step is non-negotiable. CIDs are content-addressed, so
"bytes hash to declared CID" is a property the wire format already
implicitly promises. A consumer that skips the check is essentially
trusting an arbitrary remote server with the integrity of every byte. A
consumer that *does* the check turns the CAR into a cryptographic
manifest: as long as you trust the *root* (which is signed by the
account's repo key), you transitively trust every block whose CID appears
under it.

Concretely:

```ts
for await (const event of decodeCarChunks(httpResponseBody)) {
  if (event.type === 'block') {
    // decodeCarChunks already verified this — we get to use it.
    blockstore.put(event.cid, event.bytes)
  }
}
```

If a block's bytes don't hash to its declared CID, the iterator throws.
That's the moment to drop the connection and surface a sync error — not
something to log and continue past.

## The implementation

`src/pds/car/encode.ts` and `src/pds/car/decode.ts` hand-roll the format.
We chose not to use `@ipld/car` (which is in `package.json` and would work
fine) because reading the implementation is the point.

### The varint

LEB128 in nine lines:

```ts
export function encodeVarint(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`varint: ${n}`)
  const buf = new Uint8Array(10)
  let i = 0, v = n
  while (v >= 0x80) {
    buf[i++] = (v & 0x7f) | 0x80
    v = Math.floor(v / 128)   // not >>>, which truncates to 32 bits
  }
  buf[i++] = v & 0x7f
  return buf.subarray(0, i)
}
```

The `Math.floor(v / 128)` instead of `v >>> 7` matters: JavaScript's
bitwise operators truncate to 32 bits, but a CAR block length could
legitimately exceed `2^32` for a big repo. We accept any non-negative
integer up to `Number.MAX_SAFE_INTEGER` (`2^53 − 1`), which encodes in at
most 8 bytes. Anything bigger throws.

The decoder mirrors this exactly — accumulate `(byte & 0x7f) * shift`,
multiply `shift` by 128 each iteration, stop when the continuation bit
clears.

### The encoder

`encodeCarChunks` is the streaming form: yield the header chunk, then one
chunk per block. The one-shot `encodeCar` just concatenates the chunks.

```ts
export async function* encodeCarChunks(args: CarStreamInput) {
  yield await encodeHeader(args.roots)
  for await (const block of toAsyncIterable(args.blocks)) {
    yield encodeBlock(block)
  }
}
```

The header is one DAG-CBOR encode (which the codec module already does)
prefixed by its varint length. Each block is the varint of
`cid.bytes.length + block.bytes.length`, followed by the CID bytes,
followed by the block bytes. No buffering — a 4 GB repo is the same code
path as a 4 KB repo.

The point of the streaming variant is `getRepo`. A large account's
repository can be tens of megabytes. Materializing it as one
`Uint8Array` allocates that much and then `fetch` re-copies it; with the
streaming generator we just pipe straight into the HTTP response.

The one-shot `encodeCar` exists for the cases where size isn't a worry:
firehose commit diffs (usually < 10 KB), the self-test, and unit tests
elsewhere in the codebase. Internally it's a thin `for await` over
`encodeCarChunks`.

### The decoder

The decoder is structurally trickier because it has to parse a length-
delimited byte stream, possibly chunk-by-chunk.

`ChunkReader` is a small buffered reader over `Uint8Array | AsyncIterable<Uint8Array>`
exposing only `readVarint`, `readExact(n)`, and `atEnd()`. The CAR parser
above it is then almost a transcript of the spec:

```ts
const headerLen = await reader.readVarint()
const header = parseHeader(await reader.readExact(headerLen))
yield { type: 'header', header }
while (!(await reader.atEnd())) {
  const bodyLen = await reader.readVarint()
  const body = await reader.readExact(bodyLen)
  const { cid, cidLen } = parseCidPrefix(body)
  const blockBytes = body.subarray(cidLen)
  await verifyHash(cid, blockBytes)
  yield { type: 'block', cid, bytes: blockBytes }
}
```

`verifyHash` re-hashes `blockBytes` with SHA-256 and compares to the
multihash inside the CID. Any mismatch throws.

### The 36-byte shortcut

When parsing a block, we have to know where the CID ends inside the body
bytes — otherwise we don't know where the block payload starts. The
spec-compliant way is to walk four varints (version, codec, hash code,
hash size) plus `hash size` raw bytes, exactly the way `multiformats`
does it under the hood.

But for the PDS, every block we ever produce or consume has the same
shape: **CIDv1, codec dag-cbor (0x71), multihash sha2-256 (0x12), size 32
bytes**. Four single-byte varints plus 32 hash bytes = **36 bytes flat**.
So we fast-path that case:

```ts
function parseCidPrefix(bytes: Uint8Array) {
  if (
    bytes.length >= 36 &&
    bytes[0] === 0x01 && bytes[1] === 0x71 &&
    bytes[2] === 0x12 && bytes[3] === 0x20
  ) {
    return { cid: CID.decode(bytes.subarray(0, 36)), cidLen: 36 }
  }
  return parseCidGeneric(bytes)  // walk the varints
}
```

> 📖 Is hard-coding 36 bytes safe? For *our* PDS, yes — it produces
> nothing else. But the AT Protocol doesn't forbid other multihashes
> (a future spec revision could move to sha2-512 or sha3-256), and a
> non-PDS tool could in principle hand us a CAR with mixed CID shapes.
> The fallback `parseCidGeneric` walks the four varints the proper way
> for those cases. The fast path is a perf optimization that makes the
> common case obvious in code, not a correctness shortcut.

### Self-test

`runCarSelfTest()` builds three DAG-CBOR blocks (two leaves and a root),
encodes them into a CAR, decodes it back, and asserts the round-trip is
exact. It's exported from `decode.ts` so the chapter's "Try it" section
below has something to call.

## Try it

```ts
import { runCarSelfTest } from '~/pds/car/decode'

await runCarSelfTest()  // throws on any mismatch
```

Or end-to-end, by hand:

```ts
import { encode } from '~/pds/codec'
import { encodeCar } from '~/pds/car/encode'
import { decodeCar } from '~/pds/car/decode'

const a = await encode({ greeting: 'hello' })
const b = await encode({ greeting: 'world' })
const car = await encodeCar({ roots: [a.cid], blocks: [a, b] })

const { header, blocks } = await decodeCar(car)
console.log(header.roots[0].toString())  // bafyrei…
console.log(blocks.length)                // 2
```

If you tamper with a single byte of `car` between encode and decode (try
`car[car.length - 5] ^= 0xff`), `decodeCar` will throw with "block bytes
do not hash to declared CID". The format is doing exactly what it
promises.

To use the streaming form against an HTTP response:

```ts
const response = await fetch('https://pds.example/xrpc/com.atproto.sync.getRepo?did=did:plc:…')
for await (const event of decodeCarChunks(response.body!)) {
  if (event.type === 'block') blockstore.put(event.cid, event.bytes)
}
```

Each block is verified the moment its bytes arrive. The connection can
fail halfway through; everything you accepted before the failure is still
cryptographically valid.

## Exercises

1. The CAR header is itself DAG-CBOR. Why does the spec length-prefix it
   with a varint, given that CBOR is already self-delimiting and a
   decoder could just call `dagCbor.decode(restOfStream)`?
2. Build a CAR with two blocks where one block's CID is wrong (encode
   block A's bytes with block B's CID). What does `decodeCar` do? At
   which byte does it detect the problem?
3. Implement a sanity check on top of `decodeCar`: every block whose CID
   appears in another block's bytes (via tag 42) must be present in the
   same CAR. (This is "the CAR is closed under reference" — the property
   that makes a `getRepo` response self-sufficient.)
4. The streaming encoder accepts an `AsyncIterable<Block>`. What happens
   if the source throws mid-stream — does the HTTP response just stop
   cleanly, or does the client see a corrupt CAR? What would you change
   if you wanted a more graceful failure?

## Sync endpoints

CAR is a wire format. The endpoints under `com.atproto.sync.*` are what
puts CARs *on* the wire. They're the half-dozen routes a relay, an
archiver, or another PDS calls to learn the state of this one.

| Endpoint | Body | Purpose |
| --- | --- | --- |
| `getRepo` | CAR | full repository |
| `getBlocks` | CAR | specific blocks by CID |
| `getRecord` | CAR | one record + Merkle proof |
| `getLatestCommit` | JSON | `{ cid, rev }` |
| `getRepoStatus` | JSON | `{ did, active, status?, rev? }` |
| `listRepos` | JSON | paginated repo enumeration |

The three CAR endpoints are the ones the chapter has been building up to.
`getRepo` is the export; `getBlocks` is the random-access slice;
`getRecord` is the targeted Merkle proof. The three JSON endpoints are the
catalog the others hang off — a relay calls `listRepos` first, then
`getLatestCommit` per repo to decide whether a backfill is needed, then
`getRepo` to actually pull the bytes.

### Walking the MST for `getRepo`

The interesting part of `getRepo` is enumerating which blocks belong in
the CAR. The set is: the signed commit, the MST root, every internal MST
node, and every leaf value (one CID per record). The naïve plan is "scan
`repo_blocks` for this DID" — and that mostly works — but it loses any
ordering signal and would also include orphans the GC hasn't reaped yet.
Walking the tree is more honest.

We do it by hand rather than reaching into `MST` internals. The MST class
manages a *mutable* in-memory tree intended for `add`/`update`/`delete`;
for export we just want to read. So `src/pds/repo/sync.ts` decodes one
MST node at a time and recurses:

```ts
async function walkMst(repoDid, nodeCid, out, seen) {
  if (seen.has(nodeCid.toString())) return
  seen.add(nodeCid.toString())
  out.push(nodeCid)

  const block = await getBlock(repoDid, nodeCid)
  const node = await decode<MstNode>(block.bytes, nodeCid)

  if (node.l) await walkMst(repoDid, node.l, out, seen)
  for (const entry of node.e) {
    out.push(entry.v)                                // leaf value CID
    if (entry.t) await walkMst(repoDid, entry.t, out, seen)
  }
}
```

That's the whole traversal: depth-first, left-pointer first, then each
`(leaf, right-pointer)` pair in order. The `seen` set is paranoia — MSTs
share blocks across commits, and a future change to this code path that
walks history would otherwise re-emit the same block.

Once we have the CID list we stream them through `encodeCarChunks`:

```ts
const blocks = (async function* () {
  for (const cid of cids) yield await getBlock(repoDid, cid)
})()
const car = encodeCarChunks({ roots: [commitCid], blocks })
return new Response(new ReadableStream({ ... }))
```

No buffering. The first byte of the CAR header can be on the wire before
the second block has been read from postgres.

### Records vs proofs

`getRecord` is the same machinery, narrowed. Instead of emitting every
block we emit only the ones a consumer needs to verify *one* record: the
commit, every MST node along the path from root to the relevant leaf,
plus the leaf's value block. The result is a Merkle proof — the consumer
can hash-check the chain back to the signed commit and convince itself
the record really exists in this repo at this revision, without holding
the rest of the tree.

The path-walk decoder mirrors the MST's lookup logic: at each node,
reconstruct the leaf keys (the prefix-compressed `e[i].k` bytes), find
the slot the record key falls into, and recurse through the appropriate
pointer. That gives a list of `O(log n)` nodes plus one leaf — usually
six or seven blocks for a healthy account, regardless of how many
records the repo holds.

> ⚠️ Our `getRecord` currently only accepts the *head* commit. The
> lexicon allows a historical `commit` CID; we reject anything else with
> `CommitNotFound` because we don't retain old roots. That's a deferred
> feature, not a protocol violation.

### `since`, briefly

`getRepo` accepts a `since=<rev>` parameter that, in principle, lets a
caller request "only blocks newer than this revision". Implementing it
properly needs either time-tagged block rows or the previous MST root to
diff against. For now we accept the parameter and ignore it — the
consumer pulls the whole repo and discards what it already has.

## Up next

CAR gets bytes out of the PDS. The next chapter, [09 — Lexicons](./09-lexicons.md),
explains how clients and servers agree on what those bytes *mean* before
we put them into records.

← [07 — Commits and signing](./07-commits-and-signing.md) · → [09 — Lexicons](./09-lexicons.md)
