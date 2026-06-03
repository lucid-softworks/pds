// Shared vitest bootstrap.
//
// `~/lib/config` reads env vars on first call and caches the result. We
// have to set them *before* any test file imports config (directly or
// transitively through auth, repo, account…). Putting this in a setup
// file guarantees it runs first.
//
// Each test file that wants a fresh DB sets `DATABASE_URL` to a unique
// pglite path via `tests/db.ts`'s `setupTestDbEnv`. Vitest's per-file
// isolation (pool: 'forks') means the `~/lib/db` Proxy singleton is also
// fresh per file, so the env-var-on-first-import trick works.

import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

process.env.PDS_PUBLIC_URL ??= 'http://localhost:3000'
process.env.PDS_HOSTNAME ??= 'localhost'
// 64 zero hex chars = 32 bytes — the minimum the config validator accepts.
process.env.PDS_JWT_SECRET ??=
  '0'.repeat(64)
process.env.BLOB_DIR ??= mkdtempSync(join(tmpdir(), 'pds-test-blobs-'))
// Default DATABASE_URL points at a unique pglite directory so tests that
// touch `~/lib/db` without overriding it still get a private DB. Tests
// that need migrations applied call `setupTestDbEnv()` from tests/db.ts.
process.env.DATABASE_URL ??= `pglite:${mkdtempSync(join(tmpdir(), 'pds-test-db-'))}`
