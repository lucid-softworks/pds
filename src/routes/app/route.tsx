// Layout route for /app/*.
//
// The login page (/app), the feed (/app/feed) and the compose page
// (/app/compose) all share this. We don't put the sub-nav here because the
// login page shouldn't show a Feed/Compose/Logout bar — the sub-nav is
// rendered by the feed + compose routes themselves, which know they have a
// session at render time.
//
// Per-route beforeLoad guards (in index.tsx / feed.tsx / compose.tsx) handle
// the redirect logic. Doing it here would either run on every navigation
// (login page included) or require the layout to introspect the matched
// child — both worse than the per-route version.

import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/app')({
  component: AppLayout,
})

function AppLayout() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Outlet />
    </div>
  )
}
