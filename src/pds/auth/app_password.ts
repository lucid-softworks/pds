// App passwords.
//
// Alternate credentials a user can mint for CLIs / bots / archival scripts.
// The plaintext is *server-generated*, in the format `xxxx-xxxx-xxxx-xxxx`
// over a 32-char alphabet (a-z plus 2-9, skipping look-alikes). 16 chars at
// ~5 bits each → ~80 bits of entropy, well clear of brute-force.
//
// We hash via the same `scrypt:v1:` format as `accounts.password_hash`, so
// `verifyPassword` is the only verifier the rest of the codebase needs to
// know about. The plaintext is returned to the caller exactly once, at
// creation time; no row stores it.
//
// See chapter 13 — Authentication.

import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { db } from '~/lib/db'
import { appPasswords, type AppPassword } from '~/lib/db/schema'
import { hashPassword, verifyPassword } from './password'

// Same narrowing trick as `sequence.ts`: the db union collapses `.returning`
// to its no-arg form, so we widen to a shared shape for the typed overload.
const pg = db as unknown as PgDatabase<PgQueryResultHKT>

export type CreatedAppPassword = {
  name: string
  password: string
  privileged: boolean
  createdAt: Date
}

export type AppPasswordSummary = {
  name: string
  privileged: boolean
  createdAt: Date
}

// 32 chars, all unambiguous. Skips 0/1/l/o so a human reading off a label
// can't confuse them.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

export async function createAppPassword(args: {
  did: string
  name: string
  privileged?: boolean
}): Promise<CreatedAppPassword> {
  const password = generateAppPasswordString()
  const passwordHash = await hashPassword(password)
  const privileged = args.privileged ?? false
  const rows = await pg
    .insert(appPasswords)
    .values({
      did: args.did,
      name: args.name,
      passwordHash,
      privileged,
    })
    .returning({ createdAt: appPasswords.createdAt })
  const createdAt = rows[0]!.createdAt
  return { name: args.name, password, privileged, createdAt }
}

export async function verifyAppPassword(
  did: string,
  candidate: string,
): Promise<AppPassword | null> {
  // Cost is one scrypt per row, but a user's row count is tiny (single
  // digits in practice). If that ever stops being true we add a prefix
  // column to narrow the scan; today this is fine.
  const rows = await db
    .select()
    .from(appPasswords)
    .where(eq(appPasswords.did, did))
  for (const row of rows) {
    if (await verifyPassword(candidate, row.passwordHash)) return row
  }
  return null
}

export async function listAppPasswords(
  did: string,
): Promise<AppPasswordSummary[]> {
  const rows = await db
    .select({
      name: appPasswords.name,
      privileged: appPasswords.privileged,
      createdAt: appPasswords.createdAt,
    })
    .from(appPasswords)
    .where(eq(appPasswords.did, did))
  return rows
}

export async function revokeAppPassword(
  did: string,
  name: string,
): Promise<void> {
  await db
    .delete(appPasswords)
    .where(and(eq(appPasswords.did, did), eq(appPasswords.name, name)))
}

function generateAppPasswordString(): string {
  // 16 chars from a 32-char alphabet: 5 bits each, 80 bits total. Pull a
  // byte per character and mod into the alphabet — the bias from 256 mod 32
  // is exactly zero because 32 divides 256.
  const bytes = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[bytes[i]! & 0x1f]
    if (i === 3 || i === 7 || i === 11) out += '-'
  }
  return out
}
