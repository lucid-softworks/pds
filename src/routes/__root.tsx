import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import appCss from '~/styles/app.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      {
        title: 'PDS — a teaching port of the Bluesky personal data server',
      },
      {
        name: 'description',
        content:
          'A from-scratch reimplementation of the Bluesky PDS in TanStack Start, paired with tutorial chapters that explain each subsystem so you can build your own.',
      },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      // SVG favicon scales crisp at every density; modern browsers all
      // accept it. The asset lives in public/ so Vite copies it
      // verbatim into dist/client/.
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  // One QueryClient per browser tab. useState's initializer fires exactly
  // once per mount, so we don't recreate the cache on re-render. SSR is
  // safe because TanStack Start re-runs the component on the server and
  // creates its own (throwaway) client there — none of our queries fire
  // during SSR (they're all gated on a localStorage session), so there's
  // no hydration payload to dehydrate.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Treat data as fresh for a minute — avoids refetch storms on
            // route remount during quick back/forward navigation.
            staleTime: 60 * 1000,
            // refetchOnWindowFocus is on by default; that's the behaviour
            // we want for the feed (come back, see new posts).
            retry: 1,
          },
        },
      }),
  )
  return (
    <QueryClientProvider client={queryClient}>
      <RootDocument>
        <Outlet />
      </RootDocument>
    </QueryClientProvider>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen antialiased">
        <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]/60 backdrop-blur sticky top-0 z-20">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link to="/" className="font-mono text-sm tracking-tight">
              <span className="text-[var(--color-accent)]">pds</span>
              <span className="text-[var(--color-fg-muted)]">
                /a teaching port
              </span>
            </Link>
            <nav className="flex gap-6 text-sm text-[var(--color-fg-muted)]">
              <Link
                to="/docs"
                className="hover:text-[var(--color-fg)] transition-colors"
                activeProps={{ className: 'text-[var(--color-fg)]' }}
              >
                Docs
              </Link>
              <Link
                to="/app"
                className="hover:text-[var(--color-fg)] transition-colors"
                activeProps={{ className: 'text-[var(--color-fg)]' }}
              >
                App
              </Link>
              <a
                href="https://atproto.com"
                target="_blank"
                rel="noreferrer"
                className="hover:text-[var(--color-fg)] transition-colors"
              >
                AT Protocol
              </a>
              <a
                href="https://github.com/bluesky-social/pds"
                target="_blank"
                rel="noreferrer"
                className="hover:text-[var(--color-fg)] transition-colors"
              >
                Reference PDS
              </a>
            </nav>
          </div>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
