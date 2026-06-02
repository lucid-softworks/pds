import { defineConfig } from 'drizzle-kit'

// Migrations are written for Postgres dialect. PGlite (used for dev) speaks the
// same SQL, so the same migration files work in both environments.
export default defineConfig({
  schema: './src/lib/db/schema',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost/pds_dev',
  },
  verbose: true,
  strict: true,
})
