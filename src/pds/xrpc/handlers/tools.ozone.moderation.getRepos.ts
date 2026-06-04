// XRPC handler: tools.ozone.moderation.getRepos
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getRepos.json
//
// Batched repo lookup — calls getRepo's logic for each DID. The
// upstream client uses this to populate "you have N new reports
// across these N accounts" panels without N+1 round-trips.

import { eq, inArray } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const dids = parseList(params.dids)
  if (dids.length === 0 || dids.length > 50) {
    throw BadRequest('dids must contain 1..50 entries', 'InvalidRequest')
  }
  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(inArray(accounts.did, dids))
  // Keep the input order in the output for caller convenience.
  const byDid = new Map(rows.map((r) => [r.did, r]))
  const repos = dids.map((did) => {
    const r = byDid.get(did)
    if (!r) {
      return {
        $type: 'tools.ozone.moderation.defs#repoViewNotFound',
        did,
      }
    }
    return {
      did: r.did,
      handle: r.handle,
      email: r.email,
      indexedAt: r.createdAt.toISOString(),
      relatedRecords: [],
    }
  })
  void eq
  return { repos }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.getRepos'
