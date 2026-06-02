# `codec/` — CIDs and DAG-CBOR

Every other subsystem talks in terms of *blocks*: a chunk of bytes addressed by
a [CID](https://github.com/multiformats/cid). The PDS encodes its blocks as
[DAG-CBOR](https://ipld.io/specs/codecs/dag-cbor/spec/) — a strict subset of
CBOR with a deterministic encoder, so the same logical value always hashes to
the same CID.

This module wraps the IPLD libraries (`multiformats`, `@ipld/dag-cbor`) with a
small ergonomic API tuned for the PDS:

- `encode(value)` → returns `{ bytes, cid }`
- `decode(bytes)` → returns the value (and verifies the CID if given)
- `cidForBytes(bytes, codec?, hasher?)` → just the CID

See **[Chapter 05 — Content addressing and DAG-CBOR](../../../docs/05-cid-and-dagcbor.md)**
for the conceptual walkthrough.

Implementation lands in this chapter's session.
