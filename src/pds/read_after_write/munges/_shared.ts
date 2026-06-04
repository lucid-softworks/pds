// Helpers shared by the per-NSID read-after-write munges.
//
// Two shapes:
//   - `buildPostView(local, author)` — translate a local
//     `app.bsky.feed.post` record into a minimal feedViewPost.
//   - `mergeProfileRecord(profile, localRecord)` — overlay the local
//     `app.bsky.actor.profile` record's display fields onto an
//     AppView-served profileView. Avatar/banner refs become bare CIDs
//     (the AppView would normally resolve them to CDN URLs; we ship
//     the CID and let the client fall back to gpost-CDN format
//     `https://cdn.bsky.app/img/avatar/plain/<did>/<cid>@jpeg`).

import type { LocalRecord } from '../index'

export type Author = {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  [k: string]: unknown
}

export type PostView = {
  $type?: string
  uri: string
  cid: string
  author: Author
  record: unknown
  indexedAt: string
  [k: string]: unknown
}

export type FeedViewPost = {
  post: PostView
  reply?: unknown
  reason?: unknown
}

export function buildPostView(local: LocalRecord, author: Author): FeedViewPost {
  return {
    post: {
      $type: 'app.bsky.feed.defs#postView',
      uri: local.uri,
      cid: local.cid,
      author,
      record: local.record,
      indexedAt: local.indexedAt,
    },
  }
}

type ProfileViewLike = {
  did?: string
  displayName?: string
  description?: string
  avatar?: string
  banner?: string
  [k: string]: unknown
}

type ProfileRecord = {
  displayName?: string
  description?: string
  avatar?: { ref?: { $link?: string } | string; $link?: string } | string
  banner?: { ref?: { $link?: string } | string; $link?: string } | string
  [k: string]: unknown
}

/** Overlay the requester's local profile record onto an AppView-served
 *  profileView. Only fields present in the local record overwrite the
 *  upstream value — partial updates compose correctly. */
export function mergeProfileRecord<T extends ProfileViewLike>(
  view: T,
  record: ProfileRecord,
): T {
  const next: T = { ...view }
  if (record.displayName !== undefined) next.displayName = record.displayName
  if (record.description !== undefined) next.description = record.description
  const avatar = extractCidString(record.avatar)
  if (avatar !== undefined) next.avatar = avatar
  const banner = extractCidString(record.banner)
  if (banner !== undefined) next.banner = banner
  return next
}

/** Pull the CID string out of a record-encoded blob ref. Records store
 *  blobs as either `{ "$type":"blob","ref":{"$link":"<cid>"},"size","mimeType" }`
 *  or (pre-spec) the raw CID string. Either form yields the CID. */
function extractCidString(
  blobRef: ProfileRecord['avatar'],
): string | undefined {
  if (!blobRef) return undefined
  if (typeof blobRef === 'string') return blobRef
  const ref = blobRef.ref
  if (typeof ref === 'string') return ref
  if (ref && typeof ref === 'object' && '$link' in ref) {
    return ref.$link
  }
  if (blobRef.$link) return blobRef.$link
  return undefined
}
