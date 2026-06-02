# Content addressing and DAG-CBOR

Before we can build the Merkle Search Tree in the next chapter, we need to
understand what its leaves are: **blocks of bytes addressed by their hash**.
This is the same trick git uses, and IPFS, and a dozen other systems. The AT
Protocol picks one specific shape, and we live with the consequences
everywhere else.

## The shape we use

Every block in the PDS:

- Is encoded as **DAG-CBOR**.
- Is hashed with **SHA-256**.
- Is identified by a **CIDv1** wrapping the multihash + codec.

That's the whole spec. The rest of this chapter is *why* and *how*.

## CIDs from first principles

A CID — **Content IDentifier** — is just three things glued together:

```
┌──────────┬──────────┬────────────────────┐
│ version  │  codec   │      multihash     │
│  (v1)    │ (dag-cbor│  (sha2-256, 32 B)  │
│   0x01   │   0x71)  │                    │
└──────────┴──────────┴────────────────────┘
```

When serialized as text we prepend a multibase prefix (`b` for base32) and
encode the whole thing. So a CID like `bafyreig5p…` decodes to:

- `b` — base32 multibase
- `01` — CIDv1
- `71` — codec = dag-cbor
- `12` — hash function = sha2-256
- `20` — hash length = 32 bytes
- `…` — the 32-byte hash

If you ever need to debug a CID, the [explorer at cid.ipfs.tech](https://cid.ipfs.tech/)
breaks it down. The `multiformats` library does it programmatically.

> **Why CIDv1 and not v0?** v0 only supports sha-256 + dag-pb (the IPFS
> codec). CIDv1 lets us pick our own codec (dag-cbor) and hash (sha-256).
> v0 is just a backwards-compat thing for early IPFS; nobody uses it for
> new systems.

## Why dag-cbor and not JSON?

CBOR is "binary JSON." It supports the same data model — strings, numbers,
booleans, null, arrays, maps — plus a few extras (bytestrings, tagged
values). It's smaller on the wire and faster to parse.

But the *real* reason we use it is that CBOR has [a strict deterministic
encoding profile](https://www.rfc-editor.org/rfc/rfc8949#section-4.2)
which JSON does not. JSON lets you:

- Order map keys however you like.
- Use 1.0 or 1 to mean the same number.
- Pretty-print, or not.
- Use single quotes, or double, or unquoted keys.

Each variation produces different bytes, which produces a different hash,
which produces a different CID. JSON is hostile to content addressing.

DAG-CBOR is CBOR with a few additional rules that nail down all the
"however you like" knobs:

1. Map keys must be strings.
2. Map keys must be sorted by their byte length, then lexicographically.
3. Integers use their shortest possible encoding.
4. Floats are always 64-bit.
5. No tagged values except tag 42 (the CID tag).
6. No undefined / NaN / Infinity.

Given the rules, any DAG-CBOR encoder produces the same bytes for the same
data structure, on any platform, in any language. Hence: same hash, same
CID. Content addressing works.

> **Tag 42** is "this CBOR byte string is actually a CID." It's how a record
> stored in the MST references another record or a blob. When you see
> `cid-link` in lexicon docs, that's tag 42 under the hood.

## The codec module

We wrap two libraries:

- [`multiformats`](https://github.com/multiformats/js-multiformats) — does
  CID construction, multihash, multibase. The IPLD ecosystem's plumbing.
- [`@ipld/dag-cbor`](https://github.com/ipld/js-dag-cbor) — DAG-CBOR
  encode/decode that enforces the deterministic profile.

Our `src/pds/codec/index.ts` (lands with this chapter's session) will export
three helpers:

```ts
import * as dagCbor from '@ipld/dag-cbor'
import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'

/** Encode a value to DAG-CBOR and return the bytes + content-addressed CID. */
export async function encode(value: unknown): Promise<{
  bytes: Uint8Array
  cid: CID
}> {
  const bytes = dagCbor.encode(value)
  const hash = await sha256.digest(bytes)
  return { bytes, cid: CID.createV1(dagCbor.code, hash) }
}

/** Decode DAG-CBOR bytes back to a value. If `expectedCid` is given,
 *  hash the bytes and verify before returning. */
export async function decode<T = unknown>(
  bytes: Uint8Array,
  expectedCid?: CID,
): Promise<T> {
  if (expectedCid) {
    const hash = await sha256.digest(bytes)
    if (!expectedCid.multihash.bytes.every((b, i) => b === hash.bytes[i])) {
      throw new Error('CID mismatch: bytes did not hash to the expected CID')
    }
  }
  return dagCbor.decode<T>(bytes)
}

/** Just the CID, without keeping the bytes around. */
export async function cidForBytes(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes)
  return CID.createV1(dagCbor.code, hash)
}
```

Twenty lines of code. The rest of the PDS is built on top.

## Why this matters for the MST

The MST stores **CID-keyed pointers**. When the tree's structure changes —
even by inserting a single record — many internal nodes' bytes change, so
their CIDs change. The root CID rolls up the entire repository's state into
one 36-byte fingerprint.

Two MSTs with the same root CID *are bit-for-bit identical*. Two MSTs with
different roots differ *somewhere*, and you can binary-search down through
the tree comparing CIDs to find exactly where. This is what makes the
firehose's diff format possible: "here are the blocks that changed" is a
well-defined set.

## DAG-CBOR by example

The data model is the same as JSON, just encoded differently. A record:

```json
{
  "$type": "app.bsky.feed.post",
  "text": "hello world",
  "createdAt": "2026-06-02T18:34:00.000Z"
}
```

DAG-CBOR encodes that to (broken into pieces):

```
a3                          # map of 3 pairs
  64 24 74 79 70 65         # key: "$type" (string, 5 bytes — wait, 6 due to $)
  72 …                       # value: "app.bsky.feed.post" (string, 18 bytes)
  64 74 65 78 74            # key: "text" (string, 4 bytes)
  6b …                       # value: "hello world" (string, 11 bytes)
  69 63 72 65 …             # key: "createdAt"
  78 …                       # value: ISO timestamp
```

Notice the keys are sorted by *byte length first*, then lexicographically.
`"text"` (4 bytes) comes before `"$type"` (6 bytes), which comes before
`"createdAt"` (9 bytes). Decoders don't care about that order — they parse
keys into a map regardless — but *encoders* must produce that exact order
to get the same bytes.

## A note on Buffer vs Uint8Array

In Node, you'll have `Buffer`. In the browser (and in PGlite's WASM
environment), you'll only have `Uint8Array`. The IPLD libraries return
`Uint8Array` everywhere. **Don't normalize to `Buffer` inside the PDS code**
— the codec layer wants the universal type so the same modules can run in
any environment. Only at the HTTP boundary do we convert (and TanStack
Start's response helpers handle it).

## Try it

After this session's code lands you'll be able to:

```bash
pnpm tsx scripts/cid-demo.ts
```

…and see the same record always produce the same CID, even after re-encoding
it from disk and back.

For now, you can run the same thing in your head:

```ts
encode({ hello: 'world' })           // → CID: bafyrei…something
encode({ hello: 'world' })           // → CID: bafyrei…same thing
encode({ HELLO: 'world' })           // → CID: bafyrei…different
encode({ hello: 'world', x: 1 })     // → CID: bafyrei…different again
```

If any two of those gave different CIDs for what *should* be the same data,
the content-addressing assumption would break and the whole protocol would
collapse. So the determinism matters more than it might first seem.

## Exercises

1. Why does the dag-cbor spec mandate sorted keys instead of allowing any
   order? (Hint: think about what a *decoder* would have to track to
   detect a violation.)
2. Pick a CID from any AT-URI in a real Bluesky post. Decode the multibase
   prefix and identify which codec + hash function it uses.
3. If we used SHA-512 instead of SHA-256, what would change about the CID?
   What would *not* change about how the PDS uses it?

## Up next

We have addressable bytes. Now we need to put many of them in a structure
the protocol can reason about: [Chapter 06 — Merkle Search Trees](./06-merkle-search-tree.md).
