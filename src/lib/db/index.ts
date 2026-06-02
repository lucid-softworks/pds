import path from 'node:path'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { PGlite } from '@electric-sql/pglite'
import postgres from 'postgres'
import * as schema from './schema'

// We expose a single `db` symbol so the rest of the code never has to know
// which backend is wired up. PGlite (Postgres compiled to WASM) runs the dev
// loop entirely in-process — no Docker, no external server. In production the
// same Drizzle schema and the same migrations target a real Postgres URL.
//
// Drizzle's typed query builder is identical across these adapters; the
// difference is only in the connection factory.

type Db =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>

let _db: Db | null = null

export function getDb(): Db {
  if (_db) return _db
  const url = process.env.DATABASE_URL
  if (!url || url.startsWith('pglite:') || url === 'pglite') {
    const dir =
      url && url.startsWith('pglite:')
        ? url.slice('pglite:'.length)
        : path.join(process.cwd(), '.pglite')
    const client = new PGlite(dir)
    _db = drizzlePglite(client, { schema })
    return _db
  }
  const sql = postgres(url, { max: 10, prepare: false })
  _db = drizzlePostgres(sql, { schema })
  return _db
}

// Convenience: most call sites don't need to think about the factory.
// We bind methods to the real `db` so chained query-builder calls
// (db.select().from(...)) see the right `this` regardless of the proxy.
export const db = new Proxy({} as Db, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>
    const value = real[prop]
    return typeof value === 'function' ? (value as Function).bind(real) : value
  },
}) as Db

export { schema }
