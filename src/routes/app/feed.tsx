// /app/feed — the logged-in user's own posts, newest first.
//
// Data fetching uses TanStack Query (`useQuery`) so that:
//   1. The query is gated on `enabled: !!session` — `useClientSession()`
//      starts null during SSR + first client render and populates from
//      localStorage on the next pass. A plain useEffect with deps=[]
//      runs once before the session arrives, hits its early return, and
//      never re-fires; useQuery just waits.
//   2. Refetch-on-window-focus and stale-time tracking come for free, so
//      coming back to the tab shows fresh posts without a full reload.
//
// `listRecords` returns ascending-by-rkey by default. AT Protocol rkeys
// are TIDs (timestamp identifiers, lexicographically sortable by creation
// time), so `reverse=true` is "newest first".

import { createFileRoute, redirect, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AppNav } from '~/components/app/AppNav'
import { PostCard, type PostRecord } from '~/components/app/PostCard'
import { getSession, useClientSession } from '~/lib/client/session'
import { xrpcCall, XrpcError } from '~/lib/client/xrpc'

export const Route = createFileRoute('/app/feed')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return // SSR pass: defer the check
    if (!getSession()) {
      throw redirect({ to: '/app' })
    }
  },
  component: FeedPage,
})

type ListRecordsResponse = {
  records: PostRecord[]
  cursor?: string
}

function FeedPage() {
  const session = useClientSession()

  const query = useQuery({
    // session?.did is in the key so a re-login as a different account
    // invalidates the old result cleanly.
    queryKey: ['app', 'feed', session?.did],
    enabled: !!session,
    queryFn: async () => {
      const res = await xrpcCall<ListRecordsResponse>(
        'com.atproto.repo.listRecords',
        {
          auth: true,
          params: {
            repo: session!.did,
            collection: 'app.bsky.feed.post',
            limit: 50,
            reverse: true,
          },
        },
      )
      return res.records
    },
  })

  if (!session) {
    // beforeLoad already redirected us; this branch covers the SSR pass
    // where the redirect is skipped.
    return null
  }

  // An ExpiredToken means refresh / re-login. We trip the redirect from
  // the render path because useQuery's onError is deprecated in v5; doing
  // it here keeps the effect-free shape.
  if (
    query.error instanceof XrpcError &&
    query.error.errorCode === 'ExpiredToken'
  ) {
    if (typeof window !== 'undefined') window.location.href = '/app'
    return null
  }

  const errorMessage =
    query.error && !(query.error instanceof XrpcError && query.error.errorCode === 'ExpiredToken')
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not load feed.'
      : null

  const posts = query.data ?? null

  return (
    <>
      <AppNav handle={session.handle} />
      <div className="mt-6 space-y-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Your posts</h1>
          <Link
            to="/app/compose"
            className="text-sm text-[var(--color-accent)] hover:underline"
          >
            + new post
          </Link>
        </header>
        {errorMessage ? (
          <p className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {errorMessage}
          </p>
        ) : null}
        {query.isPending && !errorMessage ? (
          <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>
        ) : null}
        {posts && posts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-fg-muted)]">
            No posts yet.{' '}
            <Link to="/app/compose" className="text-[var(--color-accent)] hover:underline">
              Write the first one →
            </Link>
          </p>
        ) : null}
        {posts && posts.length > 0 ? (
          <div className="space-y-3">
            {posts.map((p) => (
              <PostCard key={p.uri} post={p} />
            ))}
          </div>
        ) : null}
      </div>
    </>
  )
}
