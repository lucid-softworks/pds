// Vite dev-server plugin that applies the same CORS headers we set in
// production (server.ts → withCors / corsPreflight) so dev and prod
// behave identically. Without this, `pnpm dev` would silently let
// cross-origin browser clients work — until the next deploy, when they'd
// hit a wall.
//
// The headers list is duplicated rather than shared with `src/lib/cors.ts`
// because this module is bundled into `vite.config.ts` by esbuild before
// `vite-tsconfig-paths` is active, so `~/lib/cors` can't resolve here.
// The two stay in sync by code review; there's a comment over there too.
//
// See chapter 10 — XRPC, and chapter 18 — Running in production.

import type { Plugin } from 'vite'

// See src/lib/cors.ts for the full story. Short version: `*` catches
// every `x-bsky-*` request header at once, but the spec refuses to
// wildcard `Authorization` so we list it explicitly.
const ALLOW_HEADERS = '*, Authorization'
const ALLOW_METHODS = 'GET, POST, OPTIONS'
const EXPOSE_HEADERS = '*'

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': ALLOW_METHODS,
  'access-control-allow-headers': ALLOW_HEADERS,
  'access-control-expose-headers': EXPOSE_HEADERS,
  'access-control-max-age': '3600',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
}

export function corsVitePlugin(): Plugin {
  return {
    name: 'pds:cors',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Always announce CORS support, even on error responses, so the
        // browser can read the body to surface a useful message.
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v)

        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.setHeader('content-length', '0')
          res.end()
          return
        }
        next()
      })
    },
  }
}
