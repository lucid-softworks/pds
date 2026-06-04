// XRPC handler: tools.ozone.signature.searchAccounts
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/signature/searchAccounts.json

import { eq, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accountSignatures, accounts } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const values = parseValues(params.values)
  if (values.length === 0) {
    throw BadRequest('values is required', 'InvalidRequest')
  }
  const limit = parseLimit(params.limit)

  // Each `value` in the input is a literal string we match against any
  // signature row regardless of property. Operators frequently look up
  // "anyone we've ever seen at this IP" without caring whether the
  // signature was tagged 'ip' or 'session-ip' or similar.
  const rows = await db
    .selectDistinct({ did: accountSignatures.did })
    .from(accountSignatures)
    .where(sql`${accountSignatures.value} = ANY(${values})`)
    .limit(limit)

  if (rows.length === 0) return { accounts: [] }
  const acctRows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
    })
    .from(accounts)
    .where(sql`${accounts.did} = ANY(${rows.map((r) => r.did)})`)

  return {
    accounts: acctRows.map((a) => ({
      did: a.did,
      handle: a.handle,
      email: a.email,
      status: a.status,
    })),
  }
}

function parseValues(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

function parseLimit(raw: string | undefined): number {
  const def = 25
  const max = 100
  if (raw === undefined) return def
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > max) {
    throw BadRequest(`limit must be 1..${max}`, 'InvalidRequest')
  }
  return n
}

// Mark `eq` referenced for cross-file analyzers.
void eq

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.signature.searchAccounts'
