// Vitest configuration.
//
// One config, both subsystem tests (under src/**) and integration tests
// (under tests/**). We keep the path-alias support that the rest of the
// repo uses (`~/` → `./src/`) by delegating to vite-tsconfig-paths.
//
// Tests run in the `node` environment — no JSDOM. Nothing here needs a
// browser; the React routes are out of scope per the test plan.

import { defineConfig } from 'vitest/config'
import viteTsConfigPaths from 'vite-tsconfig-paths'

// vite-tsconfig-paths' shipped types still target vite 5 while the workspace
// has resolved vite 6 transitively. The plugin works fine at runtime — we
// cast through `unknown` to keep the rest of the file type-clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tsPaths = viteTsConfigPaths({
  projects: ['./tsconfig.json'],
}) as unknown as any

export default defineConfig({
  plugins: [tsPaths],
  test: {
    environment: 'node',
    globals: false,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    // Per-file isolation keeps PGlite instances + the `~/lib/db` module
    // singleton from leaking across files. Each .test.ts gets a fresh
    // worker (and therefore a fresh `db` proxy).
    isolate: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/pds/**/*.ts'],
      exclude: [
        'src/pds/**/*.test.ts',
        'src/pds/**/README.md',
        'src/pds/**/selfTest.ts',
      ],
    },
  },
})
