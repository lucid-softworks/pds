# Blobs

> 🚧 This chapter ships with the `src/pds/blob/` session.

Images and videos don't live in the MST. They live in a separate
content-addressed store, and records reference them by CID + mime type.

## Outline

1. **The blob ref type.** `{ ref: CID, mimeType: string, size: number }` —
   stored inline in records, the actual bytes elsewhere.
2. **Upload flow.** `com.atproto.repo.uploadBlob` — server hashes, stores,
   returns the ref. The blob is *not* yet attached to any record at this
   point.
3. **Attachment.** When a record references a blob in its body, we record
   the link in `record_blobs`. This lets GC find orphans later.
4. **Storage backends.** Filesystem in dev, S3-compatible in prod. One
   interface, two adapters.
5. **Serving.** `com.atproto.sync.getBlob` streams the bytes with a
   verifying hash so the client can refuse a corrupted response.
6. **Garbage collection.** Periodic sweep: any blob with zero
   `record_blobs` rows older than 24h is removed. We never delete on the
   spot — edits frequently re-attach the same blob to a new record.

## Where the code goes

- `src/pds/blob/store.ts` — interface + filesystem/S3 adapters.
- `src/pds/blob/upload.ts`
- `src/pds/blob/gc.ts`

← [14 — Records](./14-records.md) · → [16 — Firehose](./16-firehose.md)
