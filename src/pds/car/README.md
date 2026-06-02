# `car/` — CAR file encoding

[CAR (Content Addressable aRchives)](https://ipld.io/specs/transport/car/) is
how a repository ships across the wire. A CAR file is just:

```
varint(header_length) ++ DAG-CBOR(header) ++ block* 
block := varint(length) ++ cid_bytes ++ block_bytes
```

The PDS uses CARs in two places:

1. As the response body of `com.atproto.sync.getRepo` — a full export.
2. As the payload of firehose `#commit` events — a *diff*, just the blocks
   that changed in this commit.

We wrap `@ipld/car` to enforce the AT-Protocol-specific constraints (single
root CID = the new commit, blocks in commit order so a streaming consumer can
verify as bytes arrive).

See **[Chapter 08 — CAR files](../../../docs/08-car-files.md)**.
