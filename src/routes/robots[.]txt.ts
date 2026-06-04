// TanStack Start API route: GET /robots.txt
//
// Matches the reference PDS (packages/pds/src/basic-routes.ts) — the PDS
// hosts public API data and we want crawlers to be able to fetch it. The
// body is intentionally identical to upstream so operators reading the
// two side by side aren't surprised.

import { createFileRoute } from '@tanstack/react-router'

const BODY = '# Hello!\n\n# Crawling the public API is allowed\nUser-agent: *\nAllow: /\n'

export function handleRobots(): Response {
  return new Response(BODY, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async () => handleRobots(),
    },
  },
})
