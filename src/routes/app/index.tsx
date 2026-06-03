// /app — login page.
//
// If we already have a session in localStorage we bounce straight to
// /app/feed. The check happens in `beforeLoad`, which runs on every
// navigation; that means a logged-in user typing /app in the address bar
// also gets the redirect.
//
// `beforeLoad` runs on both the server and the client during SSR, but
// `getSession()` is safe to call: it returns null when `window` is undefined,
// which means the SSR pass renders the login form. The client then
// re-evaluates on hydration and redirects if a session is present.

import { createFileRoute, redirect } from '@tanstack/react-router'
import { LoginForm } from '~/components/app/LoginForm'
import { getSession } from '~/lib/client/session'

export const Route = createFileRoute('/app/')({
  beforeLoad: () => {
    if (getSession()) {
      throw redirect({ to: '/app/feed' })
    }
  },
  component: LoginPage,
})

function LoginPage() {
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-accent-2)]">
        Sign in
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Log in to your PDS
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--color-fg-muted)]">
        This is a minimal in-repo client. It talks to <em>this</em> PDS — the
        one you're running locally — using the legacy session JWT flow. See
        <a
          className="ml-1 text-[var(--color-accent)] hover:underline"
          href="/docs/client-ui"
        >
          chapter 22
        </a>
        {' '}for the design notes.
      </p>
      <LoginForm />
    </div>
  )
}
