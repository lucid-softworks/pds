// Read-after-write munge for `app.bsky.feed.getPostThread`.
//
// The thread response is a recursive tree: `{ thread: threadViewPost }`
// where each node has `parent?: threadViewPost | notFoundPost` and
// `replies?: threadViewPost[]`. We walk it and:
//
//   1. If any node's `post.uri` matches a local post URI, replace
//      that node's `post` with the freshly-built local view. (The
//      AppView's snapshot of the post is older than what's now in
//      our repo.)
//   2. If a node is missing replies that we have locally (a reply
//      the user wrote that the AppView hasn't indexed yet),
//      synthesize new child nodes.
//
// We don't try to fix `notFoundPost` entries from a different
// repo — the upstream PDS doesn't either; that needs the AppView's
// view of the other author's repo.

import type { LocalRecord, MungeArgs } from '../index'
import { buildPostView, type Author, type PostView } from './_shared'

type ThreadNode = {
  $type?: string
  post?: PostView
  parent?: ThreadNode
  replies?: ThreadNode[]
  [k: string]: unknown
}

export type ThreadResponse = {
  thread: ThreadNode
  threadgate?: unknown
}

export async function getPostThreadMunge(
  args: MungeArgs<ThreadResponse>,
): Promise<ThreadResponse> {
  const { original, local, requester, requesterHandle } = args
  if (local.posts.length === 0) return original

  const author: Author = { did: requester, handle: requesterHandle }
  const localByUri = new Map(local.posts.map((p) => [p.uri, p]))
  // Track which local URIs we've already merged so a second occurrence
  // (deep in the tree) doesn't create a duplicate.
  const mergedUris = new Set<string>()

  const visit = (node: ThreadNode): ThreadNode => {
    const next: ThreadNode = { ...node }
    if (next.post?.uri && localByUri.has(next.post.uri)) {
      const localPost = localByUri.get(next.post.uri)!
      next.post = {
        ...next.post,
        cid: localPost.cid,
        record: localPost.record,
        indexedAt: localPost.indexedAt,
      }
      mergedUris.add(next.post.uri)
    }
    if (next.parent) next.parent = visit(next.parent)
    if (next.replies) next.replies = next.replies.map(visit)

    // Synthesize replies from local posts whose `reply.parent.uri` is
    // this node's URI — they were written *into* this thread but the
    // AppView hasn't indexed them yet.
    if (next.post?.uri) {
      const synthesizedReplies = local.posts
        .filter(
          (p) =>
            !mergedUris.has(p.uri) &&
            isReplyTo(p, next.post!.uri),
        )
        .map((p) => {
          mergedUris.add(p.uri)
          return {
            $type: 'app.bsky.feed.defs#threadViewPost',
            ...buildPostView(p, author),
          } as ThreadNode
        })
      if (synthesizedReplies.length > 0) {
        next.replies = [...(next.replies ?? []), ...synthesizedReplies]
      }
    }
    return next
  }

  return { ...original, thread: visit(original.thread) }
}

function isReplyTo(post: LocalRecord, parentUri: string): boolean {
  const record = post.record as
    | { reply?: { parent?: { uri?: string } } }
    | undefined
  return record?.reply?.parent?.uri === parentUri
}
