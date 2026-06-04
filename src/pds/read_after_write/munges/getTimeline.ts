// Read-after-write munge for `app.bsky.feed.getTimeline`.
//
// Unlike getAuthorFeed (which is scoped to a single author), the
// timeline mixes posts from many authors. The merge rule:
//   - For each local post that the AppView's response doesn't already
//     include, splice it into the feed at its `indexedAt`-ordered
//     position (newest first).
//   - Author is the requester (the only person whose local posts we
//     can see — repos are per-account).
//
// The AppView serves the timeline with its own ranking; we don't try
// to outsmart it. We only ensure the requester's own just-written
// posts are visible while the AppView catches up.

import type { MungeArgs } from '../index'
import { buildPostView, type Author, type FeedViewPost } from './_shared'

export type TimelineResponse = {
  feed: FeedViewPost[]
  cursor?: string
}

export async function getTimelineMunge(
  args: MungeArgs<TimelineResponse>,
): Promise<TimelineResponse> {
  const { original, local, requester, requesterHandle } = args
  if (local.posts.length === 0) return original

  const author: Author = original.feed[0]?.post.author?.did === requester
    ? original.feed[0]!.post.author
    : { did: requester, handle: requesterHandle }
  const existingUris = new Set(original.feed.map((f) => f.post.uri))

  const additions: FeedViewPost[] = []
  for (const post of local.posts) {
    if (existingUris.has(post.uri)) continue
    additions.push(buildPostView(post, author))
  }
  if (additions.length === 0) return original

  const merged = [...original.feed, ...additions].sort((a, b) =>
    a.post.indexedAt > b.post.indexedAt ? -1 : 1,
  )
  return { ...original, feed: merged }
}
