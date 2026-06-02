// XRPC handler: com.atproto.admin.getAccountInfo
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/getAccountInfo.json
//
// One account's operator-facing snapshot. The upstream lexicon optionally
// includes related-records and a repo summary; we ship the minimum useful
// payload (handle, email, indexedAt, status) and leave the rest for a
// follow-on chapter.
//
// See chapter 19 — Moderation.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'

const handler: Handler = async ({ params, authorization }) => {
  await requireAdmin(authorization)
  const did = params.did?.trim()
  if (!did) {
    throw BadRequest('did parameter is required', 'InvalidRequest')
  }
  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      emailConfirmedAt: accounts.emailConfirmedAt,
      indexedAt: accounts.createdAt,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`account not found: ${did}`, 'AccountNotFound')
  return {
    did: row.did,
    handle: row.handle,
    email: row.email,
    indexedAt: row.indexedAt.toISOString(),
    status: row.status,
    ...(row.emailConfirmedAt
      ? { emailConfirmedAt: row.emailConfirmedAt.toISOString() }
      : {}),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.admin.getAccountInfo'
