# CAR files

> 🚧 This chapter ships with the `src/pds/car/` session.

[CAR (Content Addressable aRchives)](https://ipld.io/specs/transport/car/) is
how repositories are transported on the wire. It's a thin envelope around a
list of `(CID, bytes)` blocks with a header naming the root.

## Outline

1. **The format.** A varint length, a DAG-CBOR header, then a stream of
   `varint(length) || cid || bytes` blocks.
2. **Two uses in the PDS.**
   - Full export: `com.atproto.sync.getRepo` returns the entire repo as one
     CAR with the current commit as the root.
   - Diff payload: firehose `#commit` events carry a CAR with *just* the
     changed blocks (commit + new MST internals + new leaves).
3. **Streaming reads.** A consumer can verify each block as bytes arrive —
   hash the bytes, check against the block's declared CID, move on.
4. **What "verifying" a CAR actually means.** Bytes hash to CID; commit
   signs the root CID; you trust the bytes only as much as you trust the
   key.

## Where the code goes

- `src/pds/car/encode.ts` — streaming CAR encoder.
- `src/pds/car/decode.ts` — streaming CAR decoder, returns an async iterable
  of blocks.

## Spec links

- [CAR v1 format](https://ipld.io/specs/transport/car/carv1/)
- [Sync spec — getRepo and subscribeRepos payloads](https://atproto.com/specs/sync)

← [07 — Commits and signing](./07-commits-and-signing.md) · → [09 — Lexicons](./09-lexicons.md)
