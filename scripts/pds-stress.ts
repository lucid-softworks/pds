// scripts/pds-stress.ts — sustained-load smoke against a fresh PDS.
//
// Where pds-bench measures a single orchestrator in isolation, this script
// drives the whole signup-then-post path at scale: N accounts, each posting
// M times. The goal is to catch the failure modes that only show up under
// throughput — sequence-table back-pressure, MST node bloat, lock contention,
// connection-pool starvation — not to produce competition-grade numbers.
//
//   pnpm stress [--accounts <n>] [--posts-per-account <m>] [--data-dir <path>]
//
// Defaults: 100 accounts × 10 posts. Sequential, single-process — the PDS
// itself isn't multi-user concurrent in this codebase yet, and running
// concurrent loads through the same `~/lib/db` proxy would just stress the
// connection pool rather than the orchestrators.
//
// IMPORTANT: this file MUST set DATABASE_URL + the config env vars BEFORE
// importing anything that touches ~/lib/db or ~/lib/config. See the
// vitest.setup.ts comment for the Proxy-init reason.

import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'

// ─── env bootstrap ──────────────────────────────────────────────────────────

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    accounts: { type: 'string', default: '100' },
    'posts-per-account': { type: 'string', default: '10' },
    'data-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (parsed.values.help) {
  process.stdout.write(`
pds-stress [--accounts <n>] [--posts-per-account <m>] [--data-dir <path>]

Generate N accounts × M posts against a fresh PGlite. Prints elapsed
time, per-second throughput, and the on-disk DB size.

Options:
  --accounts <n>            Number of accounts (default 100)
  --posts-per-account <m>   Posts per account (default 10)
  --data-dir <path>         PGlite directory (default /tmp/pds-stress-<random>;
                            cleaned up at the end unless --data-dir is set)
  -h, --help                This message

See docs/18-production.md → "Benchmarking + load testing".
`)
  process.exit(0)
}

const N_ACCOUNTS = Number.parseInt(parsed.values.accounts ?? '100', 10)
const M_POSTS = Number.parseInt(parsed.values['posts-per-account'] ?? '10', 10)
if (!Number.isFinite(N_ACCOUNTS) || N_ACCOUNTS < 1) {
  process.stderr.write(`✗ --accounts must be a positive integer\n`)
  process.exit(1)
}
if (!Number.isFinite(M_POSTS) || M_POSTS < 0) {
  process.stderr.write(`✗ --posts-per-account must be a non-negative integer\n`)
  process.exit(1)
}

const userDataDir = parsed.values['data-dir']
const DATA_DIR =
  userDataDir ?? mkdtempSync(join(tmpdir(), 'pds-stress-'))
const BLOB_DIR = mkdtempSync(join(tmpdir(), 'pds-stress-blobs-'))
const CLEANUP_DATA = !userDataDir

process.env.PDS_PUBLIC_URL ??= 'http://localhost:3000'
process.env.PDS_HOSTNAME ??= 'localhost'
process.env.PDS_JWT_SECRET ??= '0'.repeat(64)
process.env.PDS_OAUTH_SIGNING_KEY ??= '0'.repeat(64)
process.env.BLOB_DIR = BLOB_DIR
process.env.DATABASE_URL = `pglite:${DATA_DIR}`
process.env.PDS_LOCAL_PLC = 'true'

// ─── deferred imports ───────────────────────────────────────────────────────

const { migrateProcessDb } = await import('../tests/db')
await migrateProcessDb()

const { db } = await import('~/lib/db')
const { sql } = await import('drizzle-orm')
const { createAccount } = await import('~/pds/account/create')
const { applyWrites } = await import('~/pds/repo/writes')

// ─── helpers ────────────────────────────────────────────────────────────────

const RUN_PREFIX = `stress${Date.now().toString(36)}`

function ok(msg: string): void {
  process.stdout.write(`✓ ${msg}\n`)
}
function info(msg: string): void {
  process.stdout.write(`  ${msg}\n`)
}
function warn(msg: string): void {
  process.stdout.write(`⚠ ${msg}\n`)
}
function fail(msg: string): void {
  process.stderr.write(`✗ ${msg}\n`)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

// Postgres exposes pg_database_size(current_database()) for the on-disk size
// of the running DB. We try it first because it's the only honest answer for
// a hosted Postgres run; PGlite (in practice) also implements it. If a build
// of PGlite without it shows up — or the SQL otherwise errors — we fall back
// to a recursive directory stat under the pglite path.
async function measureDbSize(dataDir: string): Promise<{
  bytes: number
  method: 'pg_database_size' | 'directory-stat' | 'unknown'
}> {
  try {
    type Row = { bytes: bigint | number | string }
    const raw = (await db.execute(
      sql`SELECT pg_database_size(current_database()) AS bytes`,
    )) as unknown as Row[] | { rows: Row[] }
    const rows = Array.isArray(raw) ? raw : raw.rows
    const first = rows[0]
    if (first && first.bytes !== undefined && first.bytes !== null) {
      return { bytes: Number(first.bytes), method: 'pg_database_size' }
    }
  } catch {
    // Fall through to the directory-stat path. PGlite ships a stubbed
    // pg_database_size that returns null / errors depending on version; a
    // hosted Postgres run returns a real byte count.
  }
  try {
    return { bytes: directorySize(dataDir), method: 'directory-stat' }
  } catch {
    return { bytes: 0, method: 'unknown' }
  }
}

function directorySize(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += directorySize(full)
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size
      } catch {
        // Race against tmpfs cleanup — skip files that vanish under us.
      }
    }
  }
  return total
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ok(`pglite at ${DATA_DIR}`)
  info(`plan: ${N_ACCOUNTS} accounts × ${M_POSTS} posts = ${N_ACCOUNTS * M_POSTS} total writes`)

  const tCreatesStart = performance.now()
  const dids: string[] = []
  for (let i = 0; i < N_ACCOUNTS; i++) {
    const result = await createAccount({
      handle: `${RUN_PREFIX}u${i}.test`,
      email: `${RUN_PREFIX}u${i}@stress.test`,
      password: 'stresspass-1234',
    })
    dids.push(result.did)
    if ((i + 1) % 10 === 0) {
      info(`  accounts: ${i + 1}/${N_ACCOUNTS}`)
    }
  }
  const tCreatesEnd = performance.now()
  const accountElapsedSec = (tCreatesEnd - tCreatesStart) / 1000

  const tPostsStart = performance.now()
  let posted = 0
  for (let a = 0; a < dids.length; a++) {
    const did = dids[a]
    if (!did) continue // satisfy noUncheckedIndexedAccess
    for (let p = 0; p < M_POSTS; p++) {
      await applyWrites({
        did,
        writes: [
          {
            action: 'create',
            collection: 'app.bsky.feed.post',
            value: {
              $type: 'app.bsky.feed.post',
              text: `stress post a${a} p${p}`,
              createdAt: new Date().toISOString(),
            },
          },
        ],
      })
      posted++
    }
    if ((a + 1) % 10 === 0) {
      info(`  posts: ${posted}/${N_ACCOUNTS * M_POSTS}`)
    }
  }
  const tPostsEnd = performance.now()
  const postElapsedSec = (tPostsEnd - tPostsStart) / 1000

  const totalElapsedSec = (tPostsEnd - tCreatesStart) / 1000
  const accountsPerSec = N_ACCOUNTS / accountElapsedSec
  const postsPerSec = posted === 0 ? 0 : posted / postElapsedSec

  const size = await measureDbSize(DATA_DIR)

  process.stdout.write('\n')
  process.stdout.write(`total accounts:        ${N_ACCOUNTS}\n`)
  process.stdout.write(`total posts:           ${posted}\n`)
  process.stdout.write(`elapsed:               ${totalElapsedSec.toFixed(1)}s\n`)
  process.stdout.write(`account creates/sec:   ${accountsPerSec.toFixed(1)}\n`)
  process.stdout.write(`post creates/sec:      ${postsPerSec.toFixed(1)}\n`)
  process.stdout.write(
    `final DB size:         ${formatBytes(size.bytes)}    (via ${size.method})\n`,
  )

  if (size.method === 'unknown') {
    warn(`could not measure DB size — neither pg_database_size nor directory stat succeeded`)
  }

  if (CLEANUP_DATA) {
    rmSync(DATA_DIR, { recursive: true, force: true })
    ok(`cleaned up ${DATA_DIR}`)
  } else {
    info(`(kept --data-dir ${DATA_DIR})`)
  }
  rmSync(BLOB_DIR, { recursive: true, force: true })
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err))
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n')
    }
    if (CLEANUP_DATA) {
      try {
        rmSync(DATA_DIR, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
    process.exit(1)
  })
