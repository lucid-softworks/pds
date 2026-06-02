import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'
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
    // WebSocket route for com.atproto.sync.subscribeRepos. TanStack Start
    // server-file routes only return HTTP Responses, so we hook the Node
    // server's `upgrade` event directly. See chapter 16.
    firehoseVitePlugin(),
  ],
})
