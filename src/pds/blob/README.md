# `blob/` — Binary attachments

Images, videos, and other large binaries don't live in the MST itself — that
would balloon every repo with megabytes of bytes. Instead, the MST stores a
*blob ref* (a CID + mime type + size), and the bytes live in a separate
content-addressed store.

This module:

- `store.ts` — pluggable backend: local filesystem in dev, S3-compatible in
  prod.
- `upload.ts` — handle a `com.atproto.repo.uploadBlob` request: hash, store,
  return the ref.
- `gc.ts` — periodically remove blobs no record references anymore.

See **[Chapter 15 — Blobs](../../../docs/15-blobs.md)**.
