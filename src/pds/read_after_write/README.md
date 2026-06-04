# read_after_write/ — merge local writes into proxied AppView reads

The PDS owns the user's repo; the AppView owns the indexed world view.
The AppView's index is built from the firehose and is
eventually-consistent — there's a window (typically < 1s, can be
longer) where the user has posted a record but the AppView hasn't yet
indexed it. Without read-after-write, a `getAuthorFeed` immediately
after `createRecord` returns the *old* feed, and the user thinks
their post didn't land.

This module fixes that. After the proxy gets the AppView's response,
it:

1. Reads the `atproto-repo-rev` header — the rev of the user's repo
   the AppView's snapshot reflects.
2. Queries our `records` table for rows whose `rev > <that-header>` —
   the records the AppView hasn't yet indexed (chapter 17 + migration
   0026 added the `rev` column).
3. Hydrates the record bodies from `repo_blocks` (CBOR decode).
4. Runs a per-endpoint **munge** function that merges the local
   records into the AppView's JSON response.

The merged response is what we return to the client.

## Registered munges

| NSID | Munge | Behavior |
| --- | --- | --- |
| `app.bsky.feed.getAuthorFeed` | `munges/getAuthorFeed.ts` | Prepends the requester's recent local posts to their own author feed. No-op for other users' feeds. |

## Adding a new munge

Pattern is:

1. Write `munges/<endpointName>.ts` exporting a `MungeFn<Response>`.
   Receive `{ original, local, requester, requesterHandle }` and
   return the merged shape.
2. Register it in `src/pds/xrpc/proxy.ts`'s `READ_AFTER_WRITE_MUNGES`
   map keyed by the NSID.
3. Add a unit test under `munges/` exercising the merge in isolation
   (use `local: LocalRecords` literal — no DB needed).

### Endpoints this pattern fits

These are the upstream PDS's read-after-write endpoints. The
infrastructure here covers all of them; each needs its own munge:

- `app.bsky.feed.getAuthorFeed` — DONE
- `app.bsky.feed.getTimeline` — TODO (prepend local posts to home feed)
- `app.bsky.feed.getPostThread` — TODO (replace stale parent / inject local replies)
- `app.bsky.feed.getActorLikes` — TODO (inject local likes)
- `app.bsky.actor.getProfile` — TODO (merge updated profile record into the response)
- `app.bsky.actor.getProfiles` — TODO (same, in batch)
- `app.bsky.feed.getFeed` — TODO (custom feed; mostly pass-through, only inject if requester appears)

See chapter 17 — PDS vs AppView vs Relay (Read-after-write).
