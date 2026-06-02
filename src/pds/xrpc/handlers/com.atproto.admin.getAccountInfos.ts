// XRPC handler: com.atproto.admin.getAccountInfos
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/getAccountInfos.json
//
// Bulk variant of getAccountInfo. Caller passes `?dids=...&dids=...`; the
// dispatcher collapses repeated keys when it builds the `params` object, so
// we go to the raw URL via `request` to read them all.
//
// See chapter 19 — Moderation.

import { inArray } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'

const handler: Handler = async ({ request, authorization }) => {
  await requireAdmin(authorization)
  const dids = new URL(request.url).searchParams.getAll('dids')
  if (dids.length === 0) {
    throw BadRequest('at least one did is required', 'InvalidRequest')
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
    .where(inArray(accounts.did, dids))
  return {
    infos: rows.map((row) => ({
      did: row.did,
      handle: row.handle,
      email: row.email,
      indexedAt: row.indexedAt.toISOString(),
      status: row.status,
      ...(row.emailConfirmedAt
        ? { emailConfirmedAt: row.emailConfirmedAt.toISOString() }
        : {}),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.admin.getAccountInfos'
