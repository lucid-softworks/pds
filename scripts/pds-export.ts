// scripts/pds-export.ts — dump the PDS's authoritative state into a portable
// directory tree.
//
// The PDS keeps the truth in three places: Postgres rows, the blob bytes on
// disk, and the local copy of each account's signed PLC operations. This
// script collects all three under one directory so an operator can rsync it
// to another machine and run `pnpm pds:import` to bring up a clone.
//
//   pnpm pds:export [--out <path>] [--include-tokens]
//
// --out             Output directory (default ./pds-backup-<isotimestamp>/).
// --include-tokens  Also dump refresh_tokens, email_tokens, oauth_par,
//                   oauth_codes. Default off — these expire in minutes/days,
//                   and a restored PDS should re-issue them on next login
//                   anyway. See chapter 23 for the tradeoff.
//
// We deliberately emit a plain directory + JSONL files instead of a tarball:
// no portable Node API exists for writing tar without an extra dep, and
// shelling out to `tar` would lock the script to Unix. The directory is easy
// to inspect with `head` / `jq`; the operator runs `tar czf` themselves to
// turn it into a single artifact for transport. See chapter 23.

import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { asc } from 'drizzle-orm'
import { db } from '~/lib/db'
import {
  accounts,
  repos,
  repoBlocks,
  refreshTokens,
  plcOperations,
  records,
  blobs,
  recordBlobs,
  repoSeq,
  appPasswords,
  emailTokens,
  inviteCodes,
  inviteCodeUses,
  reservedKeys,
  oauthPar,
  oauthCodes,
  adminAudit,
  moderationReports,
  modTeam,
  modEvents,
  modSubjectStatus,
  modReportResolution,
  labels,
  ozoneSettings,
  ozoneSets,
  ozoneSetValues,
  ozoneCommTemplates,
  verificationsIndex,
  accountSignatures,
  safelinkRules,
  safelinkEvents,
} from '~/lib/db/schema'
import { getConfig } from '~/lib/config'

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle')
const CHUNK_SIZE = 500

// Each table gets a `fetch(limit, offset)` closure that does a typed,
// ordered SELECT. The closure approach keeps drizzle's row types intact at
// the call site (no `as unknown` chains in the hot loop) while still letting
// us iterate uniformly across tables.
type TableSpec = {
  name: string
  // Bytea columns to base64-encode. Anything not listed round-trips through
  // JSON unchanged.
  byteaCols: readonly string[]
  // Bigint-mode numeric columns to stringify defensively (bigserial seq IDs
  // etc.) — drizzle returns plain numbers, but writing them as strings keeps
  // the dump safe to feed through any JSON parser without precision loss.
  bigintCols: readonly string[]
  // True for short-lived secret rows excluded by default.
  tokenLike: boolean
  fetch: (limit: number, offset: number) => Promise<Record<string, unknown>[]>
}

// Order matters: parents before children. Same order is reused on import.
// FK graph (all → accounts unless noted):
//   accounts (root)
//   repos, repo_blocks, records, blobs, record_blobs, refresh_tokens,
//   plc_operations, app_passwords, email_tokens, oauth_codes → accounts
//   invite_codes → accounts (created_by, for_account both nullable)
//   invite_code_uses → invite_codes
//   repo_seq, reserved_keys, oauth_par → no FK
function buildSpecs(): TableSpec[] {
  return [
    {
      name: 'accounts',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(accounts).orderBy(asc(accounts.did)).limit(l).offset(o),
    },
    {
      name: 'repos',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(repos).orderBy(asc(repos.did)).limit(l).offset(o),
    },
    {
      name: 'repo_blocks',
      byteaCols: ['bytes'],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(repoBlocks)
          .orderBy(asc(repoBlocks.repoDid), asc(repoBlocks.cid))
          .limit(l)
          .offset(o),
    },
    {
      name: 'records',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(records)
          .orderBy(asc(records.repoDid), asc(records.collection), asc(records.rkey))
          .limit(l)
          .offset(o),
    },
    {
      name: 'blobs',
      byteaCols: [],
      bigintCols: ['size'],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(blobs).orderBy(asc(blobs.cid)).limit(l).offset(o),
    },
    {
      name: 'record_blobs',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(recordBlobs)
          .orderBy(
            asc(recordBlobs.repoDid),
            asc(recordBlobs.recordUri),
            asc(recordBlobs.blobCid),
          )
          .limit(l)
          .offset(o),
    },
    {
      name: 'refresh_tokens',
      byteaCols: [],
      bigintCols: [],
      tokenLike: true,
      fetch: (l, o) =>
        db
          .select()
          .from(refreshTokens)
          .orderBy(asc(refreshTokens.jti))
          .limit(l)
          .offset(o),
    },
    {
      name: 'plc_operations',
      byteaCols: ['operation'],
      bigintCols: ['seq'],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(plcOperations)
          .orderBy(asc(plcOperations.did), asc(plcOperations.seq))
          .limit(l)
          .offset(o),
    },
    {
      name: 'repo_seq',
      byteaCols: ['event'],
      bigintCols: ['seq'],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(repoSeq).orderBy(asc(repoSeq.seq)).limit(l).offset(o),
    },
    {
      name: 'app_passwords',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(appPasswords)
          .orderBy(asc(appPasswords.did), asc(appPasswords.name))
          .limit(l)
          .offset(o),
    },
    {
      name: 'email_tokens',
      byteaCols: [],
      bigintCols: [],
      tokenLike: true,
      fetch: (l, o) =>
        db
          .select()
          .from(emailTokens)
          .orderBy(
            asc(emailTokens.did),
            asc(emailTokens.purpose),
            asc(emailTokens.token),
          )
          .limit(l)
          .offset(o),
    },
    {
      name: 'invite_codes',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(inviteCodes)
          .orderBy(asc(inviteCodes.code))
          .limit(l)
          .offset(o),
    },
    {
      name: 'invite_code_uses',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(inviteCodeUses)
          .orderBy(asc(inviteCodeUses.code), asc(inviteCodeUses.usedBy))
          .limit(l)
          .offset(o),
    },
    {
      name: 'reserved_keys',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(reservedKeys)
          .orderBy(asc(reservedKeys.did))
          .limit(l)
          .offset(o),
    },
    {
      name: 'oauth_par',
      byteaCols: [],
      bigintCols: [],
      tokenLike: true,
      fetch: (l, o) =>
        db
          .select()
          .from(oauthPar)
          .orderBy(asc(oauthPar.requestUri))
          .limit(l)
          .offset(o),
    },
    {
      name: 'oauth_codes',
      byteaCols: [],
      bigintCols: [],
      tokenLike: true,
      fetch: (l, o) =>
        db
          .select()
          .from(oauthCodes)
          .orderBy(asc(oauthCodes.code))
          .limit(l)
          .offset(o),
    },
    // ─── moderation surface (chapters 19 + 24) ──────────────────────────
    // Order constraint: moderation_reports + mod_events must come before
    // mod_report_resolution (FK cascade points back at both).
    {
      name: 'admin_audit',
      byteaCols: ['params'],
      bigintCols: ['id'],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(adminAudit).orderBy(asc(adminAudit.id)).limit(l).offset(o),
    },
    {
      name: 'moderation_reports',
      byteaCols: [],
      bigintCols: ['id'],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(moderationReports)
          .orderBy(asc(moderationReports.id))
          .limit(l)
          .offset(o),
    },
    {
      name: 'mod_team',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(modTeam).orderBy(asc(modTeam.did)).limit(l).offset(o),
    },
    {
      name: 'mod_events',
      byteaCols: ['metadata'],
      bigintCols: ['id'],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(modEvents).orderBy(asc(modEvents.id)).limit(l).offset(o),
    },
    {
      name: 'mod_subject_status',
      byteaCols: [],
      bigintCols: ['id', 'takedown_event_id'],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(modSubjectStatus)
          .orderBy(asc(modSubjectStatus.id))
          .limit(l)
          .offset(o),
    },
    {
      name: 'mod_report_resolution',
      byteaCols: [],
      bigintCols: ['report_id', 'event_id'],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(modReportResolution)
          .orderBy(asc(modReportResolution.reportId))
          .limit(l)
          .offset(o),
    },
    {
      name: 'labels',
      byteaCols: ['sig'],
      bigintCols: ['seq'],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(labels).orderBy(asc(labels.seq)).limit(l).offset(o),
    },
    // ─── ozone-extension tables (chapter 24) ──────────────────────────────
    // ozone_set_values must come after ozone_sets (FK cascade).
    {
      name: 'ozone_settings',
      byteaCols: ['value'],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(ozoneSettings)
          .orderBy(asc(ozoneSettings.key), asc(ozoneSettings.scope))
          .limit(l)
          .offset(o),
    },
    {
      name: 'ozone_sets',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db.select().from(ozoneSets).orderBy(asc(ozoneSets.name)).limit(l).offset(o),
    },
    {
      name: 'ozone_set_values',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(ozoneSetValues)
          .orderBy(asc(ozoneSetValues.setName), asc(ozoneSetValues.value))
          .limit(l)
          .offset(o),
    },
    {
      name: 'ozone_comm_templates',
      byteaCols: [],
      bigintCols: ['id'],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(ozoneCommTemplates)
          .orderBy(asc(ozoneCommTemplates.id))
          .limit(l)
          .offset(o),
    },
    {
      name: 'verifications_index',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(verificationsIndex)
          .orderBy(asc(verificationsIndex.uri))
          .limit(l)
          .offset(o),
    },
    {
      name: 'account_signatures',
      byteaCols: [],
      bigintCols: ['id'],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(accountSignatures)
          .orderBy(asc(accountSignatures.id))
          .limit(l)
          .offset(o),
    },
    {
      name: 'safelink_rules',
      byteaCols: [],
      bigintCols: [],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(safelinkRules)
          .orderBy(asc(safelinkRules.url), asc(safelinkRules.pattern))
          .limit(l)
          .offset(o),
    },
    {
      name: 'safelink_events',
      byteaCols: [],
      bigintCols: ['id'],
      tokenLike: false,
      fetch: (l, o) =>
        db
          .select()
          .from(safelinkEvents)
          .orderBy(asc(safelinkEvents.id))
          .limit(l)
          .offset(o),
    },
  ]
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: 'string' },
      'include-tokens': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (parsed.values.help) {
    printHelp()
    return
  }

  const cfg = getConfig()
  const includeTokens = parsed.values['include-tokens'] === true
  const outDir = path.resolve(
    parsed.values.out ?? `./pds-backup-${isoStamp()}`,
  )

  info(`output:         ${outDir}`)
  info(`blob source:    ${path.resolve(cfg.blobStoreDir)}`)
  info(`include tokens: ${includeTokens ? 'yes' : 'no'}`)

  await mkdirp(outDir)
  await mkdirp(path.join(outDir, 'tables'))
  await mkdirp(path.join(outDir, 'blobs'))

  const schemaHash = await hashMigrations()
  const specs = buildSpecs().filter((s) => includeTokens || !s.tokenLike)
  const counts: Record<string, number> = {}

  for (const spec of specs) {
    const dest = path.join(outDir, 'tables', `${spec.name}.jsonl`)
    counts[spec.name] = await dumpTable(spec, dest)
    ok(`${spec.name.padEnd(20)} ${counts[spec.name]} row(s)`)
  }

  const { blobCount, blobBytes } = await copyBlobs(
    cfg.blobStoreDir,
    path.join(outDir, 'blobs'),
  )
  ok(`blobs                ${blobCount} file(s)   ${formatBytes(blobBytes)}`)

  const manifest = {
    version: '1' as const,
    exportedAt: new Date().toISOString(),
    source: {
      publicUrl: cfg.publicUrl,
      hostname: cfg.hostname,
      blobStoreKind: cfg.blobStoreKind,
    },
    schemaHash,
    includedTokens: includeTokens,
    tables: specs.map((s) => ({ name: s.name, rows: counts[s.name] ?? 0 })),
    blobCount,
    blobBytes,
  }
  await fs.writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  ok(`manifest.json written`)
  info(`done — ${outDir}`)
}

// Stream-friendly chunked SELECT. We avoid pulling whole tables into memory
// by paginating with ORDER BY + LIMIT/OFFSET. OFFSET is O(N) on big tables;
// for our scale (<1M rows per table) it's fine, and the simplicity is worth
// it. A future optimisation would be keyset pagination on the spec's ORDER BY.
async function dumpTable(
  spec: TableSpec,
  destPath: string,
): Promise<number> {
  const out = createWriteStream(destPath, { encoding: 'utf8' })
  let written = 0
  try {
    let offset = 0
    while (true) {
      const rows = (await spec.fetch(CHUNK_SIZE, offset)) as Record<
        string,
        unknown
      >[]
      if (rows.length === 0) break
      for (const row of rows) {
        const encoded = encodeRow(row, spec.byteaCols, spec.bigintCols)
        const line = JSON.stringify(encoded) + '\n'
        if (!out.write(line)) {
          await new Promise<void>((res) => out.once('drain', () => res()))
        }
        written++
      }
      if (rows.length < CHUNK_SIZE) break
      offset += rows.length
    }
  } finally {
    await new Promise<void>((res, rej) => {
      out.end((err?: Error | null) => (err ? rej(err) : res()))
    })
  }
  return written
}

// Transform a row into a JSON-safe shape. We touch only the columns the spec
// flags; everything else (text, ints, booleans, ISO timestamps) round-trips
// through JSON cleanly. Bytea cells become {__bytea__: '<base64>'} so the
// import side can detect them unambiguously.
function encodeRow(
  row: Record<string, unknown>,
  byteaCols: readonly string[],
  bigintCols: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const byteaSet = new Set(byteaCols)
  const bigintSet = new Set(bigintCols)
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) {
      out[k] = null
      continue
    }
    if (byteaSet.has(k)) {
      // postgres-js → Buffer; pglite → Uint8Array. Buffer extends Uint8Array
      // so the constructor below handles both.
      const u8 =
        v instanceof Uint8Array
          ? v
          : new Uint8Array((v as { buffer: ArrayBuffer }).buffer)
      out[k] = { __bytea__: Buffer.from(u8).toString('base64') }
      continue
    }
    if (bigintSet.has(k)) {
      // bigserial / bigint columns: stringify to dodge JS number precision
      // for ids beyond 2^53. drizzle's `mode: 'number'` returns plain
      // numbers; we stringify them so import can choose its own coercion.
      out[k] = String(v as number | bigint | string)
      continue
    }
    if (v instanceof Date) {
      out[k] = v.toISOString()
      continue
    }
    out[k] = v
  }
  return out
}

async function copyBlobs(
  srcDir: string,
  destDir: string,
): Promise<{ blobCount: number; blobBytes: number }> {
  let blobCount = 0
  let blobBytes = 0
  const srcAbs = path.resolve(srcDir)
  // Tolerate a missing blob dir — a brand-new PDS with no uploads is valid.
  try {
    await fs.stat(srcAbs)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      warn(`blob source ${srcAbs} does not exist, skipping`)
      return { blobCount, blobBytes }
    }
    throw err
  }
  // FilesystemBlobStore layout: <baseDir>/<creator-did>/<cid>.bin. Walk two
  // levels deep; warn on anything else so a misconfigured store gets noticed
  // instead of silently skipped.
  const dids = await fs.readdir(srcAbs, { withFileTypes: true })
  for (const did of dids) {
    if (!did.isDirectory()) {
      warn(`unexpected non-directory in blob root: ${did.name}`)
      continue
    }
    const didSrc = path.join(srcAbs, did.name)
    const didDest = path.join(destDir, did.name)
    await mkdirp(didDest)
    const entries = await fs.readdir(didSrc, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const from = path.join(didSrc, entry.name)
      const to = path.join(didDest, entry.name)
      const stat = await fs.stat(from)
      await fs.copyFile(from, to)
      blobCount++
      blobBytes += stat.size
    }
  }
  return { blobCount, blobBytes }
}

// Hash the SQL migration corpus. The import side compares this against its
// own corpus and refuses if they diverge — that's the gate that catches
// "exported from a different schema version" before half-loaded data
// makes the situation worse.
async function hashMigrations(): Promise<string> {
  const entries = (await fs.readdir(MIGRATIONS_DIR))
    .filter((n) => n.endsWith('.sql'))
    .sort()
  const hash = createHash('sha256')
  for (const name of entries) {
    const buf = await fs.readFile(path.join(MIGRATIONS_DIR, name))
    hash.update(name)
    hash.update('\0')
    hash.update(buf)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

function isoStamp(): string {
  // 2026-06-02T19-43-12Z — colons aren't filename-safe on Windows.
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function printHelp(): void {
  process.stdout.write(`
pds-export [--out <path>] [--include-tokens]

Dumps Postgres rows + the blob store into a directory you can move,
inspect with jq, and feed to pds-import on a fresh PDS.

Options:
  --out <path>        Output dir (default ./pds-backup-<timestamp>/)
  --include-tokens    Include refresh_tokens, email_tokens, oauth_par,
                      oauth_codes. Default off; see chapter 23.
  -h, --help          This message.

Environment:
  DATABASE_URL        Postgres or pglite (default: pglite)
  BLOB_DIR            Filesystem blob root (default: ./.blobs)

See docs/23-backups.md for the format and a roundtrip walkthrough.
`)
}

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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err))
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n')
    }
    process.exit(1)
  })
