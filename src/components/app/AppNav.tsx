import { Link, useRouter } from '@tanstack/react-router'
import { logout } from '~/lib/client/session'

// Sub-nav shown on every /app/* route once you're logged in. Lives just
// below the global header (see __root.tsx). Three links: feed, compose,
// logout. The first two are TanStack <Link>s; logout is a button because it
// has side effects (revoke + clear localStorage) before we navigate.

export function AppNav({ handle }: { handle: string }) {
  const router = useRouter()

  async function handleLogout() {
    await logout()
    // Hard-navigate so any cached loader data is dropped along with the
    // session. router.invalidate() would work too but a full reload is the
    // simplest way to guarantee a clean slate for the next user.
    await router.navigate({ to: '/app' })
    router.invalidate()
  }

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]/40">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3 text-sm">
        <div className="flex gap-5 text-[var(--color-fg-muted)]">
          <Link
            to="/app/feed"
            className="hover:text-[var(--color-fg)] transition-colors"
            activeProps={{ className: 'text-[var(--color-fg)]' }}
          >
            Feed
          </Link>
          <Link
            to="/app/compose"
            className="hover:text-[var(--color-fg)] transition-colors"
            activeProps={{ className: 'text-[var(--color-fg)]' }}
          >
            Compose
          </Link>
        </div>
        <div className="flex items-center gap-4 text-xs text-[var(--color-fg-muted)]">
          <span className="font-mono">@{handle}</span>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded border border-[var(--color-border)] px-2 py-1 hover:border-[var(--color-accent)]/60 hover:text-[var(--color-fg)] transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  )
}
