// CLI: `pnpm db:migrate`
//
// Applies the .sql files in /drizzle in lexicographic order. Each successful
// file is recorded in a `__migrations` table so re-runs are no-ops. Same
// behavior whether the target is PGlite (dev) or hosted Postgres (prod) —
// the SQL files don't use any dialect-specific syntax.
//
// We deliberately hand-roll this instead of using drizzle-kit's migrator so
// the migration files are plain SQL the reader can audit, and the journal is
// a single tiny table instead of a generated meta/ directory.

import fs from 'node:fs/promises'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import postgres from 'postgres'

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle')

type Runner = (sql: string) => Promise<unknown>

async function listMigrations() {
  const entries = await fs.readdir(MIGRATIONS_DIR)
  return entries
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, full: path.join(MIGRATIONS_DIR, name) }))
}

async function ensureJournal(run: Runner) {
  await run(`CREATE TABLE IF NOT EXISTS "__migrations" (
    "name"        text PRIMARY KEY,
    "applied_at"  timestamptz NOT NULL DEFAULT now()
  )`)
}

async function applied(query: (sql: string) => Promise<{ name: string }[]>) {
  const rows = await query('SELECT "name" FROM "__migrations"')
  return new Set(rows.map((r) => r.name))
}

async function runMigrations(
  run: Runner,
  query: (sql: string) => Promise<{ name: string }[]>,
  label: string,
) {
  await ensureJournal(run)
  const done = await applied(query)
  const all = await listMigrations()
  let n = 0
  for (const m of all) {
    if (done.has(m.name)) continue
    const sql = await fs.readFile(m.full, 'utf8')
    await run(sql)
    await run(
      `INSERT INTO "__migrations" ("name") VALUES ('${m.name.replace(/'/g, "''")}')`,
    )
    console.log(`✓ applied ${m.name}`)
    n++
  }
  console.log(
    n === 0
      ? `${label}: already up to date (${all.length} migrations)`
      : `${label}: applied ${n} new migration${n === 1 ? '' : 's'}`,
  )
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url || url.startsWith('pglite:') || url === 'pglite') {
    const dir =
      url && url.startsWith('pglite:')
        ? url.slice('pglite:'.length)
        : path.join(process.cwd(), '.pglite')
    const client = new PGlite(dir)
    const run: Runner = (sql) => client.exec(sql)
    const query = async (sql: string) => {
      const r = await client.query<{ name: string }>(sql)
      return r.rows
    }
    await runMigrations(run, query, `PGlite (${dir})`)
    await client.close()
    return
  }
  const sql = postgres(url, { max: 1, prepare: false })
  const run: Runner = (s) => sql.unsafe(s)
  const query = async (s: string) =>
    (await sql.unsafe<{ name: string }[]>(s)) as { name: string }[]
  await runMigrations(run, query, `Postgres (${url.replace(/:[^:@/]+@/, ':***@')})`)
  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
