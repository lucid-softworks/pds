// scripts/pds-import.ts — restore a PDS backup into a fresh database.
//
//   pnpm pds:import <path> [--blobs-only] [--tables-only] [--force]
//
// <path>           A directory produced by `pnpm pds:export`.
// --blobs-only     Only restore blob files into BLOB_DIR.
// --tables-only    Only restore DB rows. Skip blobs.
// --force          Restore even if the target DB already has accounts.
//                  Default is to refuse — restoring over a live PDS is a
//                  destructive mistake and should be deliberate.
//
// Safety rails this script enforces:
//
//   1. Manifest required. We refuse a directory that doesn't look like a
//      pds-export output.
//   2. Schema-hash gate. The export records a sha256 of the drizzle/*.sql
//      corpus that produced it. If our corpus doesn't match, the on-disk
//      shape of the data isn't guaranteed to fit our tables — bail out and
//      tell the operator how to recover. See chapter 23.
//   3. Empty-target gate. If the `accounts` table has rows, refuse without
//      --force.
//
// Insert order matches export order, which is the FK topo sort: parents
// before children. See ~/scripts/pds-export.ts for the rationale.

import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { sql } from 'drizzle-orm'
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
const INSERT_CHUNK = 200

// (tableName → drizzle table) lookup keyed by the same SQL identifiers the
// export writes into manifest.tables. The order of this map is the insert
// order: accounts first so FKs resolve, oauth_codes last because nothing
// else references it.
const TABLES: Record<string, { _: { name: string } } & Record<string, unknown>> =
  {
    accounts: accounts as never,
    repos: repos as never,
    repo_blocks: repoBlocks as never,
    records: records as never,
    blobs: blobs as never,
    record_blobs: recordBlobs as never,
    refresh_tokens: refreshTokens as never,
    plc_operations: plcOperations as never,
    repo_seq: repoSeq as never,
    app_passwords: appPasswords as never,
    email_tokens: emailTokens as never,
    invite_codes: inviteCodes as never,
    invite_code_uses: inviteCodeUses as never,
    reserved_keys: reservedKeys as never,
    oauth_par: oauthPar as never,
    oauth_codes: oauthCodes as never,
    admin_audit: adminAudit as never,
    moderation_reports: moderationReports as never,
    mod_team: modTeam as never,
    mod_events: modEvents as never,
    mod_subject_status: modSubjectStatus as never,
    // mod_report_resolution must come AFTER moderation_reports + mod_events
    // (FK cascade)
    mod_report_resolution: modReportResolution as never,
    labels: labels as never,
    ozone_settings: ozoneSettings as never,
    ozone_sets: ozoneSets as never,
    // ozone_set_values must come AFTER ozone_sets (FK cascade)
    ozone_set_values: ozoneSetValues as never,
    ozone_comm_templates: ozoneCommTemplates as never,
    verifications_index: verificationsIndex as never,
    account_signatures: accountSignatures as never,
    safelink_rules: safelinkRules as never,
    safelink_events: safelinkEvents as never,
  }
const INSERT_ORDER = Object.keys(TABLES)

// Sequences that need realignment after a bigserial table is populated.
// Postgres assigns sequence values on insert by default, but we want to
// preserve the exported ids exactly (so existing firehose cursors stay
// valid). Inserting with explicit seq values bypasses the sequence, leaving
// it stuck at its old max — the next natural insert would collide. We bump
// the sequence past max(seq) once the table is loaded.
const BIGSERIAL_SEQUENCES: Record<string, { col: string; seqName: string }> = {
  repo_seq: { col: 'seq', seqName: 'repo_seq_seq_seq' },
  admin_audit: { col: 'id', seqName: 'admin_audit_id_seq' },
  moderation_reports: { col: 'id', seqName: 'moderation_reports_id_seq' },
  mod_events: { col: 'id', seqName: 'mod_events_id_seq' },
  mod_subject_status: { col: 'id', seqName: 'mod_subject_status_id_seq' },
  labels: { col: 'seq', seqName: 'labels_seq_seq' },
  ozone_comm_templates: {
    col: 'id',
    seqName: 'ozone_comm_templates_id_seq',
  },
  account_signatures: { col: 'id', seqName: 'account_signatures_id_seq' },
  safelink_events: { col: 'id', seqName: 'safelink_events_id_seq' },
}

type Manifest = {
  version: string
  exportedAt: string
  source: { publicUrl: string; hostname: string; blobStoreKind: string }
  schemaHash: string
  includedTokens: boolean
  tables: { name: string; rows: number }[]
  blobCount: number
  blobBytes: number
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      'blobs-only': { type: 'boolean', default: false },
      'tables-only': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })
  if (parsed.values.help || parsed.positionals.length === 0) {
    printHelp()
    if (parsed.values.help) return
    process.exit(parsed.positionals.length === 0 ? 1 : 0)
  }

  if (parsed.values['blobs-only'] && parsed.values['tables-only']) {
    fail('--blobs-only and --tables-only are mutually exclusive')
    process.exit(1)
  }

  const inputDir = path.resolve(parsed.positionals[0]!)
  const manifestPath = path.join(inputDir, 'manifest.json')
  let manifest: Manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest
  } catch (err) {
    fail(`could not read ${manifestPath}: ${(err as Error).message}`)
    process.exit(1)
    return
  }
  info(`source:         ${inputDir}`)
  info(`exported at:    ${manifest.exportedAt}`)
  info(`source host:    ${manifest.source.hostname}`)
  info(`tables:         ${manifest.tables.length}`)
  info(`blobs:          ${manifest.blobCount}`)
  info(`includedTokens: ${manifest.includedTokens ? 'yes' : 'no'}`)

  // Schema-hash gate. If our migration corpus differs from the source's, the
  // shape of the data isn't guaranteed to fit our tables, so bail.
  const ourHash = await hashMigrations()
  if (manifest.schemaHash !== ourHash) {
    fail(
      'schema hash mismatch: export was produced against a different ' +
        'drizzle/*.sql set.',
    )
    info(`  export hash:  ${manifest.schemaHash}`)
    info(`  our hash:     ${ourHash}`)
    info(`  resolution:   migrate the source PDS to this version (or check`)
    info(`                out the matching git commit), re-export, and retry.`)
    process.exit(1)
  }
  ok('schema hash matches')

  if (!parsed.values['blobs-only']) {
    await restoreTables(inputDir, manifest, parsed.values.force === true)
  }
  if (!parsed.values['tables-only']) {
    await restoreBlobs(inputDir)
  }
  info('done')
}

async function restoreTables(
  inputDir: string,
  manifest: Manifest,
  force: boolean,
): Promise<void> {
  // Empty-target gate.
  const existing = (await db
    .select({ did: accounts.did })
    .from(accounts)
    .limit(1)) as { did: string }[]
  if (existing.length > 0 && !force) {
    fail('target database has existing accounts. Use --force to bypass.')
    info('  this safeguard is here because importing on top of a populated')
    info('  PDS will conflict on primary keys and leave the DB half-merged.')
    process.exit(1)
  }

  // Build a set of the table files that actually exist on disk — the export
  // may have skipped token tables, and a future export might add new ones.
  const present = new Set(
    (await fs.readdir(path.join(inputDir, 'tables'))).filter((n) =>
      n.endsWith('.jsonl'),
    ),
  )

  for (const name of INSERT_ORDER) {
    const file = `${name}.jsonl`
    if (!present.has(file)) {
      info(`skip  ${name.padEnd(20)} (not in export)`)
      continue
    }
    const filePath = path.join(inputDir, 'tables', file)
    const inserted = await restoreOneTable(name, filePath)
    ok(`${name.padEnd(20)} ${inserted} row(s)`)
    const bs = BIGSERIAL_SEQUENCES[name]
    if (bs && inserted > 0) {
      // Realign the bigserial so the next natural insert doesn't collide
      // with a restored id. setval('seq', max(col)) leaves the sequence's
      // is_called=true so the *next* nextval() returns max(col)+1. Idempotent
      // — running again with no new rows is a no-op.
      await db.execute(
        sql.raw(
          `SELECT setval('${bs.seqName}', (SELECT COALESCE(MAX("${bs.col}"), 1) FROM "${name}"))`,
        ),
      )
    }
  }
}

async function restoreOneTable(
  name: string,
  filePath: string,
): Promise<number> {
  const table = TABLES[name]
  if (!table) {
    warn(`unknown table ${name} in export, skipping`)
    return 0
  }
  let inserted = 0
  let buffer: Record<string, unknown>[] = []
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    const row = decodeRow(JSON.parse(line) as Record<string, unknown>)
    buffer.push(row)
    if (buffer.length >= INSERT_CHUNK) {
      await flush(table, buffer)
      inserted += buffer.length
      buffer = []
    }
  }
  if (buffer.length > 0) {
    await flush(table, buffer)
    inserted += buffer.length
  }
  return inserted
}

// Matches an ISO 8601 instant (UTC, millisecond precision) produced by
// Date#toISOString. We use this to spot timestamp columns at decode time
// instead of carrying a per-table column list around — JSON has no
// timestamp type, so the only collision risk is a text column whose
// contents happen to look like a timestamp, and none of our schemas have
// one.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

// Reverse the encodeRow transform from pds-export: unwrap {__bytea__: '...'}
// objects back into Buffers, ISO instants back into Date objects (drizzle's
// timestamp mapper expects a Date, not a string), and leave everything else
// alone. Numeric strings for bigint(mode:'number') columns round-trip
// through both pg drivers without special handling.
function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && '__bytea__' in v) {
      const b64 = (v as { __bytea__: string }).__bytea__
      out[k] = Buffer.from(b64, 'base64')
      continue
    }
    if (typeof v === 'string' && ISO_INSTANT_RE.test(v)) {
      out[k] = new Date(v)
      continue
    }
    out[k] = v
  }
  return out
}

async function flush(
  table: { _: { name: string } } & Record<string, unknown>,
  rows: Record<string, unknown>[],
): Promise<void> {
  await (db.insert as (t: typeof table) => { values: (v: typeof rows) => Promise<unknown> })(
    table,
  ).values(rows)
}

async function restoreBlobs(inputDir: string): Promise<void> {
  const cfg = getConfig()
  const srcDir = path.join(inputDir, 'blobs')
  try {
    await fs.stat(srcDir)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      warn('no blobs/ directory in backup, skipping blob restore')
      return
    }
    throw err
  }
  const destDir = path.resolve(cfg.blobStoreDir)
  await fs.mkdir(destDir, { recursive: true })
  let count = 0
  let bytes = 0
  const dids = await fs.readdir(srcDir, { withFileTypes: true })
  for (const did of dids) {
    if (!did.isDirectory()) continue
    const didSrc = path.join(srcDir, did.name)
    const didDest = path.join(destDir, did.name)
    await fs.mkdir(didDest, { recursive: true })
    const entries = await fs.readdir(didSrc, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const from = path.join(didSrc, entry.name)
      const to = path.join(didDest, entry.name)
      const stat = await fs.stat(from)
      await fs.copyFile(from, to)
      count++
      bytes += stat.size
    }
  }
  ok(`blobs                ${count} file(s)   ${formatBytes(bytes)}`)
}

// Mirrors hashMigrations() in pds-export.ts. Keep these two functions in
// lockstep — any change to one is also a change to the on-disk format.
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function printHelp(): void {
  process.stdout.write(`
pds-import <path> [--blobs-only] [--tables-only] [--force]

Restores a pds-export directory into a fresh PDS.

Options:
  --blobs-only        Only copy blob files into BLOB_DIR.
  --tables-only       Only restore DB rows.
  --force             Restore even if accounts table is non-empty.
  -h, --help          This message.

Environment:
  DATABASE_URL        Target Postgres or pglite. The DB must have been
                      migrated to the same schema as the source (we check
                      a sha256 of the drizzle/*.sql corpus and refuse on
                      mismatch).
  BLOB_DIR            Target filesystem blob root (default: ./.blobs)

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
