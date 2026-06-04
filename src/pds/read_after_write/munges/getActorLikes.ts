// Read-after-write munge for `app.bsky.feed.getActorLikes`.
//
// The lexicon returns a feed of *posts the actor has liked*. A
// just-written `app.bsky.feed.like` record's subject is *another*
// account's post — we don't have its body locally. So the merge we
// can do is narrow:
//
//   - When the AppView already includes the requester's own
//     just-edited post in the feed (i.e. they liked their own
//     post), refresh that post's record/cid/indexedAt from local.
//   - We do NOT synthesize new entries for likes whose target post
//     lives in another repo — that needs the AppView round-trip.
//
// In practice this munge is a near-no-op most of the time. It exists
// for parity + to refresh the rare "user liked their own just-edited
// post" case.

import type { MungeArgs } from '../index'
import type { FeedViewPost } from './_shared'

export type ActorLikesResponse = {
  feed: FeedViewPost[]
  cursor?: string
}

export async function getActorLikesMunge(
  args: MungeArgs<ActorLikesResponse>,
): Promise<ActorLikesResponse> {
  const { original, local } = args
  if (local.posts.length === 0) return original

  const localByUri = new Map(local.posts.map((p) => [p.uri, p]))
  return {
    ...original,
    feed: original.feed.map((entry) => {
      const fresh = localByUri.get(entry.post.uri)
      if (!fresh) return entry
      return {
        ...entry,
        post: {
          ...entry.post,
          cid: fresh.cid,
          record: fresh.record,
          indexedAt: fresh.indexedAt,
        },
      }
    }),
  }
}
