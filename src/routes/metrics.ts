// TanStack Start API route: GET /metrics — Prometheus exposition.
//
// Gated behind `getConfig().metricsEnabled` (env `PDS_METRICS=true`). When
// disabled we return 404 rather than 403 so a casual probe can't tell whether
// the endpoint exists at all.
//
// Auth is intentionally omitted in the teaching port. In production, wrap
// this behind a reverse-proxy ACL (allow-list the scraper's IP, or require a
// Bearer token at the proxy layer). See chapter 18 — Observability.
//
// The route delegates to a plain `handleMetrics()` function so integration
// tests can call it without booting Vite.

import { createFileRoute } from '@tanstack/react-router'
import { getConfig } from '~/lib/config'
import { renderProm } from '~/lib/metrics'

export function handleMetrics(): Response {
  if (!getConfig().metricsEnabled) {
    return new Response('not found', { status: 404 })
  }
  return new Response(renderProm(), {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export const Route = createFileRoute('/metrics')({
  server: {
    handlers: {
      GET: async () => handleMetrics(),
    },
  },
})
