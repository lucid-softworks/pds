# Reading and writing records

> 🚧 This chapter ships with the repo-write session.

By the time you reach this chapter, almost all the machinery exists. Writing
a record is mostly *gluing it together*: validate input, allocate a TID,
add to the MST, encode + sign the new commit, persist blocks, emit a
firehose event.

## Outline

1. **The write endpoints.**
   - `com.atproto.repo.createRecord` — new record at a new rkey.
   - `com.atproto.repo.putRecord` — write at a specific rkey, replace if
     exists.
   - `com.atproto.repo.deleteRecord` — remove at rkey.
   - `com.atproto.repo.applyWrites` — atomic batch of any of the above.
2. **The transactional shape.** One commit per write *or* one commit per
   batch; both modes use a Postgres transaction so partial failure can't
   leave the MST inconsistent.
3. **Validation.** Lexicon validators from Chapter 09 enforce the record
   shape. The `$type` field selects the lexicon.
4. **The read endpoints.** `getRecord`, `listRecords`, `describeRepo`.
   These don't mutate; they query the `records` table directly for speed
   and only fall back to walking the MST when needed.
5. **CIDs in record refs.** A like points at a post by URI + CID. We
   validate that the CID is *some* prior CID for that URI, not the *current*
   one — edits don't invalidate likes.

## Where the code goes

- `src/pds/repo/repo.ts` — high-level "open repo, apply write" surface.
- `src/pds/xrpc/handlers/com/atproto/repo/*.ts` — one per endpoint.

← [13 — Authentication](./13-authentication.md) · → [15 — Blobs](./15-blobs.md)
