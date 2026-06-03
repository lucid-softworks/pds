// scripts/pds-bench.ts — microbenchmark harness for the PDS orchestrators.
//
// We time the same orchestrator functions the XRPC handlers wrap (no HTTP,
// no JSON parsing, no auth middleware) so the numbers reflect the cost of
// the work itself rather than the cost of the dispatcher. The benches that
// ship today:
//
//   createAccount   — full signup: handle + email + password → DID + tokens
//   applyWrites     — single-record app.bsky.feed.post create
//   listRecords     — page over the warmed account's posts (limit=50)
//   getRepo         — full CAR export (collectRepoCids + encodeCar)
//
//   pnpm bench [--iterations <n>] [--data-dir <path>]
//
// --iterations  How many times to run each bench (default 100).
// --data-dir    PGlite directory (default /tmp/pds-bench-<random>, cleaned up
//               at the end).
//
// We deliberately roll our own measurement instead of pulling in mitata /
// tinybench: the project has no dev deps for one-shot operator tools, and
// median + p99 over N iterations is twenty lines of code.
//
// IMPORTANT: this file MUST set DATABASE_URL + the config env vars BEFORE
// importing anything that touches ~/lib/db or ~/lib/config — see the
// vitest.setup.ts comment for why (Proxy + lazy init).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'

// ─── env bootstrap ──────────────────────────────────────────────────────────
//
// Parsed first so --data-dir wins over the random default. We also need a
// blob dir because createAccount → getConfig() reads it eagerly.

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    iterations: { type: 'string', default: '100' },
    'data-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (parsed.values.help) {
  process.stdout.write(`
pds-bench [--iterations <n>] [--data-dir <path>]

Microbenchmark the four hot-path orchestrators against a fresh PGlite.
Prints median + p99 over N iterations (default 100).

Options:
  --iterations <n>    Iteration count for each bench (default 100)
  --data-dir <path>   PGlite directory (default /tmp/pds-bench-<random>;
                      cleaned up at the end)
  -h, --help          This message

See docs/18-production.md → "Benchmarking + load testing".
`)
  process.exit(0)
}

const ITERATIONS = Number.parseInt(parsed.values.iterations ?? '100', 10)
if (!Number.isFinite(ITERATIONS) || ITERATIONS < 1) {
  process.stderr.write(`✗ --iterations must be a positive integer\n`)
  process.exit(1)
}

const userDataDir = parsed.values['data-dir']
const DATA_DIR =
  userDataDir ?? mkdtempSync(join(tmpdir(), 'pds-bench-'))
const BLOB_DIR = mkdtempSync(join(tmpdir(), 'pds-bench-blobs-'))
const CLEANUP_DATA = !userDataDir // only delete what we created

process.env.PDS_PUBLIC_URL ??= 'http://localhost:3000'
process.env.PDS_HOSTNAME ??= 'localhost'
process.env.PDS_JWT_SECRET ??= '0'.repeat(64)
process.env.PDS_OAUTH_SIGNING_KEY ??= '0'.repeat(64)
process.env.BLOB_DIR = BLOB_DIR
process.env.DATABASE_URL = `pglite:${DATA_DIR}`
// Local-PLC keeps publishPlcOp a no-op so the bench measures the PDS, not
// the network round-trip to plc.directory.
process.env.PDS_LOCAL_PLC = 'true'

// ─── deferred imports ───────────────────────────────────────────────────────
//
// These all transitively read DATABASE_URL / config env on first touch. The
// env block above must run first; top-level imports would defeat that.

const { migrateProcessDb } = await import('../tests/db')
await migrateProcessDb()

const { db } = await import('~/lib/db')
const { records } = await import('~/lib/db/schema')
const { repos } = await import('~/lib/db/schema')
const { eq, and, asc } = await import('drizzle-orm')
const { createAccount } = await import('~/pds/account/create')
const { applyWrites } = await import('~/pds/repo/writes')
const { collectRepoCids } = await import('~/pds/repo/sync')
const { getBlock, getBlocks } = await import('~/pds/repo/blockstore')
const { encodeCar } = await import('~/pds/car/encode')
const { parseCid, decode } = await import('~/pds/codec')

// ─── timing primitives ──────────────────────────────────────────────────────

type Stats = {
  median: number
  p99: number
  min: number
  max: number
  total: number
}

function summarise(samples: number[]): Stats {
  // Sort once, pick indices. Sample counts here are small (≤ a few thousand)
  // so the O(n log n) sort is free relative to the bench bodies.
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) {
    return { median: 0, p99: 0, min: 0, max: 0, total: 0 }
  }
  const mid = Math.floor(n / 2)
  // For even n we average the two middle values — same shape as a calculator
  // median. Doesn't change the p99 path.
  const median =
    n % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : sorted[mid] ?? 0
  // p99 by nearest-rank: index = ceil(0.99 * n) - 1, clamped to last element.
  const p99Index = Math.min(n - 1, Math.max(0, Math.ceil(0.99 * n) - 1))
  const p99 = sorted[p99Index] ?? 0
  let total = 0
  for (const s of sorted) total += s
  return {
    median,
    p99,
    min: sorted[0] ?? 0,
    max: sorted[n - 1] ?? 0,
    total,
  }
}

async function measure(label: string, fn: (i: number) => Promise<void>): Promise<{
  label: string
  iterations: number
  stats: Stats
}> {
  const samples: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    await fn(i)
    samples.push(performance.now() - start)
  }
  return { label, iterations: ITERATIONS, stats: summarise(samples) }
}

function fmt(ms: number): string {
  // Two-decimal milliseconds is the right granularity for everything we
  // bench here. Bigger units would lose detail on sub-millisecond paths;
  // microseconds would be noise.
  return `${ms.toFixed(2)}ms`
}

// ─── benches ────────────────────────────────────────────────────────────────
//
// All four benches share a unique-handle suffix so re-running on a dirty data
// dir doesn't collide. We pick a per-run prefix so a long bench produces
// monotonic, sortable handles.

const RUN_PREFIX = `bench${Date.now().toString(36)}`

async function benchCreateAccount(): Promise<void> {
  // One createAccount per iteration. The handle, email, and password vary
  // by iteration index so uniqueness constraints don't blow up halfway in.
  const result = await measure('createAccount', async (i) => {
    await createAccount({
      handle: `${RUN_PREFIX}a${i}.test`,
      email: `${RUN_PREFIX}a${i}@bench.test`,
      password: 'benchpass-1234',
    })
  })
  reportRow(result)
}

async function benchApplyWrites(warmDid: string): Promise<void> {
  // Single-record creates against a pre-warmed account. The rkey is left
  // unset so applyWrites picks a fresh TID each call.
  const result = await measure('applyWrites', async (i) => {
    await applyWrites({
      did: warmDid,
      writes: [
        {
          action: 'create',
          collection: 'app.bsky.feed.post',
          value: {
            $type: 'app.bsky.feed.post',
            text: `bench post #${i}`,
            createdAt: new Date().toISOString(),
          },
        },
      ],
    })
  })
  reportRow(result)
}

async function benchListRecords(warmDid: string): Promise<void> {
  // Mirrors the listRecords handler: page through the same collection with
  // limit=50, fetch the block bytes, decode each value. No HTTP, no cursor
  // pagination loop — one page per iteration so the variance reflects the
  // backend cost, not how full the table is.
  const result = await measure('listRecords', async () => {
    const rows = await db
      .select({ rkey: records.rkey, cid: records.cid })
      .from(records)
      .where(
        and(
          eq(records.repoDid, warmDid),
          eq(records.collection, 'app.bsky.feed.post'),
        ),
      )
      .orderBy(asc(records.rkey))
      .limit(50)
    if (rows.length === 0) return
    const cids = rows.map((r) => parseCid(r.cid))
    const blocks = await getBlocks(warmDid, cids)
    for (const b of blocks) {
      await decode(b.bytes, b.cid)
    }
  })
  reportRow(result)
}

async function benchGetRepo(warmDid: string): Promise<void> {
  // Replicates the sync.getRepo body: load the commit, walk the MST,
  // collect every block, build a CAR. We use encodeCar (whole-buffer)
  // because measuring the streaming variant would also measure the
  // generator overhead at this size.
  const repoRows = await db
    .select({ rootCid: repos.rootCid })
    .from(repos)
    .where(eq(repos.did, warmDid))
    .limit(1)
  const root = repoRows[0]
  if (!root) throw new Error(`no repo row for warm did ${warmDid}`)
  const commitCid = parseCid(root.rootCid)

  const result = await measure('getRepo', async () => {
    const cids = await collectRepoCids(warmDid, commitCid)
    const blocks: Array<{ cid: ReturnType<typeof parseCid>; bytes: Uint8Array }> = []
    for (const cid of cids) {
      const b = await getBlock(warmDid, cid)
      if (!b) throw new Error(`block disappeared mid-bench: ${cid}`)
      blocks.push({ cid: b.cid, bytes: b.bytes })
    }
    await encodeCar({ roots: [commitCid], blocks })
  })
  reportRow(result)
}

// ─── output ─────────────────────────────────────────────────────────────────

const HEADER = `${'benchmark'.padEnd(20)}${'iterations'.padStart(12)}${'median'.padStart(12)}${'p99'.padStart(12)}${'min'.padStart(12)}${'max'.padStart(12)}`

function reportHeader(): void {
  process.stdout.write(HEADER + '\n')
  process.stdout.write('─'.repeat(HEADER.length) + '\n')
}

function reportRow(row: { label: string; iterations: number; stats: Stats }): void {
  process.stdout.write(
    row.label.padEnd(20) +
      String(row.iterations).padStart(12) +
      fmt(row.stats.median).padStart(12) +
      fmt(row.stats.p99).padStart(12) +
      fmt(row.stats.min).padStart(12) +
      fmt(row.stats.max).padStart(12) +
      '\n',
  )
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(`✓ pglite at ${DATA_DIR}\n`)
  process.stdout.write(`  iterations: ${ITERATIONS}\n\n`)
  reportHeader()

  await benchCreateAccount()

  // Warm one extra account; benches 2-4 share it so the noise from
  // createAccount doesn't drown the smaller benches.
  const warm = await createAccount({
    handle: `${RUN_PREFIX}warm.test`,
    email: `${RUN_PREFIX}warm@bench.test`,
    password: 'benchpass-1234',
  })

  // Pre-seed a few posts before listRecords runs so the bench actually has
  // rows to page over. We don't time this — it's setup, not measurement.
  for (let i = 0; i < ITERATIONS; i++) {
    await applyWrites({
      did: warm.did,
      writes: [
        {
          action: 'create',
          collection: 'app.bsky.feed.post',
          value: {
            $type: 'app.bsky.feed.post',
            text: `warm-up #${i}`,
            createdAt: new Date().toISOString(),
          },
        },
      ],
    })
  }

  await benchApplyWrites(warm.did)
  await benchListRecords(warm.did)
  await benchGetRepo(warm.did)

  process.stdout.write(`\n  data dir: ${DATA_DIR}\n`)
  if (CLEANUP_DATA) {
    rmSync(DATA_DIR, { recursive: true, force: true })
    process.stdout.write(`✓ cleaned up ${DATA_DIR}\n`)
  } else {
    process.stdout.write(`  (kept --data-dir, not removed)\n`)
  }
  rmSync(BLOB_DIR, { recursive: true, force: true })
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
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
