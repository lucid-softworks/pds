// /app/feed — the logged-in user's own posts, newest first.
//
// We fetch on the *client* (not via a server loader) because the access JWT
// lives in localStorage. A server loader would have to either receive the
// JWT in a cookie (which we don't issue) or run unauthenticated and 404
// every time. Client-side fetching keeps the data flow honest: this view is
// just a thin wrapper over the same XRPC endpoint that curl would call.
//
// `listRecords` returns ascending-by-rkey by default. AT Protocol rkeys are
// TIDs (timestamp identifiers, lexicographically sortable by creation time),
// so `reverse=true` is equivalent to "newest first".

import { useEffect, useState } from 'react'
import { createFileRoute, redirect, Link } from '@tanstack/react-router'
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
  // `useClientSession` keeps SSR + first-client-render in lockstep (both
  // see `null`), then re-renders with the localStorage session after
  // mount. Calling `getSession()` directly here would cause React #418
  // because the server-rendered HTML wouldn't match the client's first
  // pass — see src/lib/client/session.ts.
  const session = useClientSession()
  const [posts, setPosts] = useState<PostRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await xrpcCall<ListRecordsResponse>(
          'com.atproto.repo.listRecords',
          {
            auth: true,
            params: {
              repo: session.did,
              collection: 'app.bsky.feed.post',
              limit: 50,
              reverse: true,
            },
          },
        )
        if (!cancelled) setPosts(res.records)
      } catch (err: unknown) {
        if (cancelled) return
        if (err instanceof XrpcError && err.errorCode === 'ExpiredToken') {
          window.location.href = '/app'
          return
        }
        const message = err instanceof Error ? err.message : 'Could not load feed.'
        setError(message)
      }
    })()
    return () => {
      cancelled = true
    }
  // The session reference is stable for the lifetime of a logged-in tab —
  // setSession() during login causes a router.navigate which remounts this
  // route — so a single fetch on mount is correct. We deliberately don't
  // depend on `session` to avoid lint nagging over a value we know is stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!session) {
    // The beforeLoad guard already redirected us; this branch is defensive
    // for the SSR pass where the redirect is skipped.
    return null
  }

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
        {error ? (
          <p className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        {posts === null && !error ? (
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
