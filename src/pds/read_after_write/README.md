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
| `app.bsky.feed.getTimeline` | `munges/getTimeline.ts` | Splices the requester's recent local posts into the home timeline at the correct `indexedAt`-ordered position. |
| `app.bsky.actor.getProfile` | `munges/getProfile.ts` | Overlays the local `app.bsky.actor.profile/self` record (displayName, description, avatar, banner) onto the requester's own profile response. No-op for other users' profiles. |
| `app.bsky.actor.getProfiles` | `munges/getProfiles.ts` | Same as getProfile, applied to whichever entry in the batch matches the requester. |
| `app.bsky.feed.getPostThread` | `munges/getPostThread.ts` | Walks the thread tree: refreshes any node whose URI matches a local record, and synthesizes new reply nodes for local replies the AppView hasn't indexed yet. |
| `app.bsky.feed.getActorLikes` | `munges/getActorLikes.ts` | Refreshes feed entries whose post URI matches a local record (the rare "user liked their own just-edited post" case). |

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

These are the upstream PDS's read-after-write endpoints. We ship a
munge for every one upstream covers:

- `app.bsky.feed.getAuthorFeed` — DONE
- `app.bsky.feed.getTimeline` — DONE
- `app.bsky.feed.getPostThread` — DONE
- `app.bsky.feed.getActorLikes` — DONE
- `app.bsky.actor.getProfile` — DONE
- `app.bsky.actor.getProfiles` — DONE

Upstream doesn't munge `app.bsky.feed.getFeed` (custom feeds run
entirely on the AppView; there's no local merge to do), so we don't
either.

See chapter 17 — PDS vs AppView vs Relay (Read-after-write).
