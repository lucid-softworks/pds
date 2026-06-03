// /app/compose — single-textarea post composer.
//
// Mirror of /app/feed's auth guard: if there's no session, send the user
// back to the login page. The actual XRPC call happens inside the
// `ComposeForm` component (which also does the lexicon-cap validation).

import { createFileRoute, redirect } from '@tanstack/react-router'
import { AppNav } from '~/components/app/AppNav'
import { ComposeForm } from '~/components/app/ComposeForm'
import { getSession, useClientSession } from '~/lib/client/session'

export const Route = createFileRoute('/app/compose')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return // SSR pass: defer the check
    if (!getSession()) {
      throw redirect({ to: '/app' })
    }
  },
  component: ComposePage,
})

function ComposePage() {
  // See feed.tsx for the SSR + hydration rationale.
  const session = useClientSession()
  if (!session) return null
  return (
    <>
      <AppNav handle={session.handle} />
      <div className="mt-6 space-y-4">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">New post</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Writes a single <code className="font-mono text-xs">app.bsky.feed.post</code> record to your repo via{' '}
            <code className="font-mono text-xs">com.atproto.repo.createRecord</code>.
          </p>
        </header>
        <ComposeForm />
      </div>
    </>
  )
}
