// Production Node.js entry point.
//
// TanStack Start (with Vite) emits a fetch-style handler at
// `dist/server/server.js` plus a `dist/client/` bundle of static assets.
// Per the framework's hosting docs, deployment expects a small wrapper
// that:
//
//   1. Serves static files from `dist/client/`
//   2. Forwards everything else to the fetch handler
//   3. Hooks the Node http.Server's `upgrade` event for our firehose
//      WebSocket route (the dev-only `firehose-mount.ts` plugin doesn't
//      run in production builds).
//
// We use `srvx` (the unjs project recommended by the TanStack docs) for
// (1) and (2), then reach into the underlying Node server for (3).
//
// Run with: `tsx server.ts` (see package.json `start` script).
// See chapter 18 — Running in production.

import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { serve } from 'srvx'
import { WebSocketServer } from 'ws'
import { closeDb } from './src/lib/db'
import { getLogger } from './src/lib/logger'
import { onShutdown } from './src/lib/shutdown'
import type { FirehoseClient } from './src/pds/sequencer/firehose'
import { streamFirehose } from './src/pds/sequencer/firehose'

// We always start from the project root (the dev `tsx server.ts` command
// and the systemd unit both Cwd at the repo root). Using `process.cwd()`
// gives us the same anchor whether we run the source via tsx or the
// bundled `dist/start.mjs` via plain node — `import.meta.dirname` would
// differ between the two.
const ROOT = resolve(process.cwd())
const CLIENT_DIR = join(ROOT, 'dist/client')
const SERVER_BUNDLE = join(ROOT, 'dist/server/server.js')

const FIREHOSE_PATH = '/xrpc/com.atproto.sync.subscribeRepos'
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10)
const HOSTNAME = process.env.HOST ?? '127.0.0.1'

const log = getLogger('http')

if (!existsSync(SERVER_BUNDLE)) {
  console.error(
    `missing ${SERVER_BUNDLE} — run \`pnpm vite build\` before \`pnpm start\``,
  )
  process.exit(1)
}

const { default: ssr } = (await import(SERVER_BUNDLE)) as {
  default: { fetch: (req: Request) => Promise<Response> | Response }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

function serveStatic(url: URL): Response | null {
  // Block path traversal: normalize and require the result is still
  // contained in CLIENT_DIR.
  const requested = decodeURIComponent(url.pathname)
  const candidate = normalize(join(CLIENT_DIR, requested))
  if (!candidate.startsWith(CLIENT_DIR + '/') && candidate !== CLIENT_DIR) {
    return null
  }
  if (!existsSync(candidate)) return null
  const stat = statSync(candidate)
  if (!stat.isFile()) return null

  const ext = extname(candidate).toLowerCase()
  const contentType = MIME[ext] ?? 'application/octet-stream'

  // Hashed bundles under /_build/ are content-addressed → cache forever.
  const cacheControl = url.pathname.startsWith('/_build/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=300'

  return new Response(Readable.toWeb(createReadStream(candidate)) as ReadableStream, {
    headers: {
      'content-type': contentType,
      'content-length': String(stat.size),
      'cache-control': cacheControl,
    },
  })
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const isStaticCandidate =
    request.method === 'GET' || request.method === 'HEAD'
  if (isStaticCandidate) {
    const hit = serveStatic(url)
    if (hit) return hit
  }
  return ssr.fetch(request)
}

const server = await serve({
  fetch: handler,
  port: PORT,
  hostname: HOSTNAME,
})
await server.ready()

const httpServer = server.node?.server
if (!httpServer) {
  console.error('srvx did not expose a Node http server; cannot mount firehose')
  process.exit(1)
}

// Firehose WebSocket — same shape as src/pds/sequencer/firehose-mount.ts,
// but talking to a real Node http.Server instead of Vite's dev server.
const wss = new WebSocketServer({ noServer: true })

httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const url = req.url ?? ''
  const path = url.split('?', 1)[0] ?? ''
  if (path !== FIREHOSE_PATH) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    onFirehoseConnect(ws, req).catch((err) => {
      log.error('firehose connection failed', { err })
      try {
        ws.close(1011, 'internal error')
      } catch {
        // already closed
      }
    })
  })
})

async function onFirehoseConnect(
  ws: import('ws').WebSocket,
  req: IncomingMessage,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost')
  const cursorParam = url.searchParams.get('cursor')
  const cursor = cursorParam != null ? Number.parseInt(cursorParam, 10) : 0
  if (!Number.isFinite(cursor) || cursor < 0) {
    ws.close(1008, 'cursor must be a non-negative integer')
    return
  }

  const controller = new AbortController()
  ws.on('close', () => controller.abort())
  ws.on('error', () => controller.abort())

  const client: FirehoseClient = {
    bufferedFrames: () => ws.bufferedAmount,
    send: (frame) =>
      new Promise<void>((resolve, reject) => {
        ws.send(frame, { binary: true }, (err) =>
          err ? reject(err) : resolve(),
        )
      }),
    close: (code, reason) => ws.close(code, reason),
  }

  await streamFirehose({ client, cursor, signal: controller.signal })
}

onShutdown('firehose-ws', async () => {
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutting down')
    } catch {
      // already torn down
    }
  }
  await new Promise<void>((resolveWss) => wss.close(() => resolveWss()))
})

onShutdown('db', async () => {
  await closeDb()
})

onShutdown('http', async () => {
  await server.close()
})

log.info('PDS listening', {
  port: PORT,
  hostname: HOSTNAME,
  clientDir: CLIENT_DIR,
})
