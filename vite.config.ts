import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import { corsVitePlugin } from './src/lib/cors-vite-plugin'
import { firehoseVitePlugin } from './src/pds/sequencer/firehose-mount'

export default defineConfig({
  server: {
    port: 3000,
  },
  plugins: [
    viteTsConfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart({
      // File-based routing is the default. Markdown docs are read at request time
      // from /docs by the route loader, so we don't need to inline them.
    }),
    // TanStack Start's dev mode requires React Refresh, and the prod client
    // bundle still emits `React.createElement(...)` from its own hydration
    // entry. `@vitejs/plugin-react` wires both — and it MUST come AFTER
    // `tanstackStart()` (the router plugin needs to run before JSX
    // transformation, see the error message it'll throw otherwise).
    react(),
    // WebSocket route for com.atproto.sync.subscribeRepos. TanStack Start
    // server-file routes only return HTTP Responses, so we hook the Node
    // server's `upgrade` event directly. See chapter 16.
    firehoseVitePlugin(),
    // CORS for the dev server, mirroring the prod wrapper in server.ts.
    // Every XRPC / OAuth / .well-known route is cross-origin by spec.
    corsVitePlugin(),
  ],
})
