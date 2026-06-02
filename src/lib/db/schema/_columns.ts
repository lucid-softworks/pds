import { customType } from 'drizzle-orm/pg-core'

// Raw bytes column. Postgres' BYTEA accepts/returns Buffer in postgres-js and
// Uint8Array in pglite — we narrow at the application boundary, not here.
export const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType: () => 'bytea',
})
