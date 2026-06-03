// Test-database helper.
//
// Two ways to use this file:
//
//   (a) `setupTestDbEnv()` — call this once at the top of a test file, *before*
//       any import that touches `~/lib/db`. It allocates a unique pglite
//       directory and points `DATABASE_URL` at it. The first time `~/lib/db`'s
//       Proxy is touched it will build a PGlite client at that path. We then
//       apply migrations via `applyMigrations(db)` inside a `beforeAll`.
//
//   (b) `freshDb()` — spin up a brand-new PGlite + drizzle pair, apply all
//       migrations, return the pair. Useful for tests that want isolation
//       between cases (call from `beforeEach`).
//
// The reason both exist: most tests are happiest with one DB per file (option
// a — matches how the app actually behaves). The integration test wants the
// shared singleton because the orchestrators (`createAccount`, `applyWrites`)
// all import `~/lib/db` directly and there's no DI seam.

import { mkdtempSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '~/lib/db/schema'

/** Allocate a unique pglite directory and point `DATABASE_URL` at it.
 *  Call before importing anything that touches `~/lib/db`. */
export function setupTestDbEnv(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pds-test-db-'))
  process.env.DATABASE_URL = `pglite:${dir}`
  return dir
}

/** Apply every .sql file under /drizzle in lexicographic order. */
export async function applyMigrations(client: PGlite): Promise<void> {
  const dir = join(process.cwd(), 'drizzle')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    const sql = await readFile(join(dir, f), 'utf8')
    await client.exec(sql)
  }
}

/** Build a brand-new in-memory PGlite + drizzle pair, migrate it, return it.
 *  The caller owns the lifecycle: `await env.client.close()` in afterEach. */
export async function freshDb(): Promise<{
  client: PGlite
  db: ReturnType<typeof drizzle<typeof schema>>
}> {
  const client = new PGlite()
  await applyMigrations(client)
  const db = drizzle(client, { schema })
  return { client, db }
}

/** Apply migrations to whatever PGlite the `~/lib/db` proxy is sitting on.
 *  We reach into the internals once, then never again. The proxy doesn't
 *  expose its client, so we use the env var `setupTestDbEnv` set and rebuild
 *  the same client to run migrations against the same on-disk store. */
export async function migrateProcessDb(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url || !url.startsWith('pglite:')) {
    throw new Error(
      'migrateProcessDb: DATABASE_URL must be a pglite: URL — call setupTestDbEnv first',
    )
  }
  const dir = url.slice('pglite:'.length)
  // Open a second handle to the same on-disk pglite directory. Drizzle's
  // app-side handle will see the schema once we let it lazy-init.
  const client = new PGlite(dir)
  await applyMigrations(client)
  await client.close()
}
