// WebSocket mount for `com.atproto.sync.subscribeRepos`.
//
// TanStack Start (1.168 / h3 v2) routes only return `Response` objects, so
// there's no native way to negotiate a WebSocket upgrade from a server file
// route. We instead bind to the underlying Node HTTP server's `upgrade`
// event from a Vite dev plugin. In production, Nitro's build target would
// need an equivalent hook — see chapter 16 for the production swap.
//
// `ws` is small and ubiquitous; it's the same library Vite's own HMR
// transport sits on top of. The handshake stays on Node's net layer rather
// than going through h3, which is exactly what we want for a long-lived
// streaming connection.
//
// Note: this module is imported by `vite.config.ts`, which Vite bundles
// *before* user plugins like `vite-tsconfig-paths` are active. Anything
// that resolves a `~/*` alias must therefore be `await import()`'d lazily
// inside `configureServer`, not statically imported at the top of the file.

import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Plugin, ViteDevServer } from 'vite'

const FIREHOSE_PATH = '/xrpc/com.atproto.sync.subscribeRepos'

type FirehoseClient = {
  bufferedFrames(): number
  send(frame: Uint8Array): Promise<void> | void
  close(code?: number, reason?: string): void
}

/** Attach the firehose WebSocket handler to a Node HTTP server. */
export async function attachFirehose(
  vite: ViteDevServer,
): Promise<void> {
  if (!vite.httpServer) return
  const server = vite.httpServer

  // Lazy imports via an opaque specifier: see header note about config
  // bundling and `~/*` aliases. esbuild (which Vite uses to bundle the
  // config) statically follows even concatenated relative specifiers like
  // `'./fire' + 'hose'`. Routing the import through a runtime `Function`
  // defeats the scanner so the `~/*`-using `./firehose` module is never
  // inlined into the config bundle.
  //
  // We then load `./firehose` through Vite's SSR module graph so its own
  // `~/*` imports resolve via the user's plugins (vite-tsconfig-paths).
  const load = new Function(
    'spec',
    'return import(spec)',
  ) as (spec: string) => Promise<unknown>
  const wsMod = (await load('ws')) as typeof import('ws')
  const { WebSocketServer } = wsMod
  const firehoseMod = (await vite.ssrLoadModule(
    new URL('./firehose.ts', import.meta.url).pathname,
  )) as typeof import('./firehose')
  const { streamFirehose } = firehoseMod

  const wss = new WebSocketServer({ noServer: true })

  // Graceful shutdown: close every live firehose socket with 1001 (going
  // away) so reconnecting consumers don't think they hit a server bug. We
  // register lazily via SSR-loaded shutdown to keep this file `~/*`-free at
  // top level (see header note about config bundling).
  try {
    const shutdownMod = (await vite.ssrLoadModule(
      new URL('../../lib/shutdown.ts', import.meta.url).pathname,
    )) as typeof import('../../lib/shutdown')
    shutdownMod.onShutdown('firehose-ws', async () => {
      for (const client of wss.clients) {
        try {
          client.close(1001, 'server shutting down')
        } catch {
          // socket already torn down
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    })
    // Also wire DB teardown from here — the firehose mount is the only
    // bootstrap-time hook we have under the Vite dev server. In production
    // (Nitro / Node entry) the same `~/lib/shutdown` API is the wiring
    // point; the dev server documents this caveat in chapter 18.
    const dbMod = (await vite.ssrLoadModule(
      new URL('../../lib/db/index.ts', import.meta.url).pathname,
    )) as typeof import('../../lib/db')
    shutdownMod.onShutdown('db', async () => {
      await dbMod.closeDb()
    })
  } catch (err) {
    // Shutdown wiring is best-effort; the dev server keeps running either
    // way. Log via console because the logger import would itself need the
    // SSR-loaded path.
    console.error('[firehose] failed to register shutdown handler', err)
  }

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? ''
    const path = url.split('?', 1)[0] ?? ''
    if (path !== FIREHOSE_PATH) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnect(ws, req, streamFirehose).catch((err) => {
        console.error('[firehose] connection failed', err)
        try {
          ws.close(1011, 'internal error')
        } catch {
          // already closed
        }
      })
    })
  })
}

async function onConnect(
  ws: import('ws').WebSocket,
  req: IncomingMessage,
  streamFirehose: typeof import('./firehose').streamFirehose,
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

/** Vite plugin that wires the firehose into the dev server. */
export function firehoseVitePlugin(): Plugin {
  return {
    name: 'pds:firehose-websocket',
    configureServer(server) {
      // `httpServer` is null when Vite is in middlewareMode — we're not,
      // so this is defined for `vite dev`. We fire-and-forget the async
      // attach; any failure is logged and the dev server continues.
      attachFirehose(server).catch((err) => {
        console.error('[firehose] failed to attach WebSocket handler', err)
      })
    },
  }
}
