// XRPC handler: tools.ozone.signature.findCorrelation
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/signature/findCorrelation.json
//
// Given a list of DIDs, return the (property, value) pairs they all
// share — the intersection of their signatures. Useful for "what do
// these accounts have in common?"

import { sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accountSignatures } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const dids = parseList(params.dids)
  if (dids.length < 2) {
    throw BadRequest(
      'dids must contain at least 2 entries',
      'InvalidRequest',
    )
  }

  // (property, value) pairs whose row count for the input DIDs equals
  // exactly `dids.length`. PostgreSQL's GROUP BY + HAVING handles this
  // in one query.
  const rows = await db.execute(sql`
    SELECT property, value
    FROM account_signatures
    WHERE did = ANY(${dids})
    GROUP BY property, value
    HAVING COUNT(DISTINCT did) = ${dids.length}
  `)

  // pglite + postgres-js return shapes diverge here: pglite returns
  // .rows, postgres-js returns the array directly. Handle both.
  const raw = (rows as unknown as { rows?: Array<{ property: string; value: string }> })
    .rows ?? (rows as unknown as Array<{ property: string; value: string }>)

  return {
    details: raw.map((r) => ({
      property: r.property,
      value: r.value,
    })),
  }
}

function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.signature.findCorrelation'
