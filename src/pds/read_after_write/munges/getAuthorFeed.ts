// Read-after-write munge for `app.bsky.feed.getAuthorFeed`.
//
// When the caller is viewing *their own* author feed, ensure any
// just-posted records appear at the top — the AppView's index may not
// yet reflect them. We:
//
//   1. Confirm this is the requester's own feed (the first item's
//      author DID is the requester, OR the feed is empty).
//   2. For each local post the AppView hasn't yet returned, build a
//      minimal `feedViewPost` and prepend it.
//   3. Optionally update stale `app.bsky.actor.profile` data on
//      embedded author profiles (e.g. avatar CID changed).
//
// The PostView shape we build is minimal — uri, cid, author{did,handle},
// record, indexedAt. We omit viewer state (like/repost URIs) and counts
// (likeCount, replyCount, etc.) — those depend on the AppView's index.
// The bsky.app client renders these as 0 / unselected until the AppView
// catches up, which is the right UX for the first ~1s.

import type { LocalRecord, MungeArgs } from '../index'

type Author = { did: string; handle: string; [k: string]: unknown }

type PostView = {
  $type?: string
  uri: string
  cid: string
  author: Author
  record: unknown
  indexedAt: string
  [k: string]: unknown
}

type FeedViewPost = {
  post: PostView
  reply?: unknown
  reason?: unknown
}

export type AuthorFeedResponse = {
  feed: FeedViewPost[]
  cursor?: string
}

export async function getAuthorFeedMunge(
  args: MungeArgs<AuthorFeedResponse>,
): Promise<AuthorFeedResponse> {
  const { original, local, requester, requesterHandle } = args

  if (!isUsersOwnFeed(original, requester)) return original

  const existingUris = new Set(original.feed.map((f) => f.post.uri))
  const author: Author = original.feed[0]?.post.author ?? {
    did: requester,
    handle: requesterHandle,
  }

  const prepended: FeedViewPost[] = []
  for (const post of local.posts) {
    if (existingUris.has(post.uri)) continue
    prepended.push({
      post: {
        $type: 'app.bsky.feed.defs#postView',
        uri: post.uri,
        cid: post.cid,
        author,
        record: post.record,
        indexedAt: post.indexedAt,
      },
    })
  }
  // Local records are sorted asc by indexedAt; the feed reads newest-first,
  // so reverse before prepending.
  prepended.reverse()

  return { ...original, feed: [...prepended, ...original.feed] }
}

function isUsersOwnFeed(
  feed: AuthorFeedResponse,
  requester: string,
): boolean {
  const first = feed.feed[0]
  if (!first) return true
  if (!first.reason && first.post.author.did === requester) return true
  // Reposted-by-requester also counts as "their feed."
  const reason = first.reason as { $type?: string; by?: { did?: string } } | undefined
  if (
    reason &&
    typeof reason.$type === 'string' &&
    reason.$type === 'app.bsky.feed.defs#reasonRepost' &&
    reason.by?.did === requester
  ) {
    return true
  }
  return false
}

void undefined as unknown as LocalRecord
