// XRPC handler: com.atproto.temp.fetchLabels (DEPRECATED in lexicon)
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/temp/fetchLabels.json
//
// Pre-`subscribeLabels` pull surface for label consumers that haven't
// migrated yet. Returns labels with `cts > since` (provided as a
// unix-millis integer), ordered ascending. The lexicon is flagged
// deprecated upstream; we ship it anyway because old clients still
// call it.

import { asc, gt } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { labels } from '~/lib/db/schema'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 250

const handler: Handler = async ({ params }) => {
  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const n = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
      throw BadRequest(`limit must be 1..${MAX_LIMIT}`, 'InvalidRequest')
    }
    limit = n
  }
  // `since` is a unix-millis int per the lexicon. Convert to a Date
  // for the cts (timestamptz) column comparison.
  let sinceDate: Date | undefined
  if (params.since !== undefined) {
    const ms = Number.parseInt(params.since, 10)
    if (!Number.isFinite(ms) || ms < 0) {
      throw BadRequest('since must be a non-negative integer (ms)', 'InvalidRequest')
    }
    sinceDate = new Date(ms)
  }

  const rows = await db
    .select()
    .from(labels)
    .where(sinceDate ? gt(labels.cts, sinceDate) : undefined)
    .orderBy(asc(labels.cts))
    .limit(limit)

  return {
    labels: rows.map((r) => ({
      src: r.src,
      uri: r.uri,
      ...(r.cid !== null ? { cid: r.cid } : {}),
      val: r.val,
      neg: r.neg,
      cts: r.cts.toISOString(),
      ...(r.exp !== null ? { exp: r.exp.toISOString() } : {}),
      sig: Array.from(r.sig),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.temp.fetchLabels'
