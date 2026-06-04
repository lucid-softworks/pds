// XRPC handler: tools.ozone.moderation.getRecords
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getRecords.json
//
// Batched record lookup. We fan out to per-URI SELECTs in parallel
// rather than constructing a `(col, col, col) IN (...)` tuple — keeps
// the SQL composition simple and there's no risk of injection from
// URI fragments. The 50-entry cap keeps the parallelism bounded.

import { and, eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { records } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const uris = parseList(params.uris)
  if (uris.length === 0 || uris.length > 50) {
    throw BadRequest('uris must contain 1..50 entries', 'InvalidRequest')
  }

  const results = await Promise.all(
    uris.map(async (uri) => {
      const parsed = parseAtUri(uri)
      if (!parsed) return { uri, row: null }
      const row = (
        await db
          .select({
            cid: records.cid,
            indexedAt: records.indexedAt,
            takedownRef: records.takedownRef,
          })
          .from(records)
          .where(
            and(
              eq(records.repoDid, parsed.repoDid),
              eq(records.collection, parsed.collection),
              eq(records.rkey, parsed.rkey),
            ),
          )
          .limit(1)
      )[0]
      return { uri, row: row ?? null }
    }),
  )

  return {
    records: results.map(({ uri, row }) =>
      row === null
        ? { $type: 'tools.ozone.moderation.defs#recordViewNotFound', uri }
        : {
            uri,
            cid: row.cid,
            indexedAt: row.indexedAt.toISOString(),
            takendown: row.takedownRef !== null,
          },
    ),
  }
}

function parseAtUri(uri: string): {
  repoDid: string
  collection: string
  rkey: string
} | null {
  if (!uri.startsWith('at://')) return null
  const [did, collection, rkey] = uri.slice('at://'.length).split('/')
  if (!did || !collection || !rkey) return null
  return { repoDid: did, collection, rkey }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.getRecords'
