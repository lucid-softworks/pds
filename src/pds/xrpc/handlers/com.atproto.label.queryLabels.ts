// XRPC handler: com.atproto.label.queryLabels
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/queryLabels.json
//
// Public read surface for the labeler embedded in this PDS. Any consumer
// (an AppView, another PDS, a moderation tool) can call this to discover
// what labels the team-lead account has issued.
//
// Required `uriPatterns` (array). Each entry is either a full AT-URI /
// DID or a prefix ending in `*`. Matching is boolean-OR across the
// array. The lexicon also defines `sources` (filter by labeler DID); we
// honour it but the only labeler this PDS hosts is the team-lead, so in
// practice it's a tautology — useful when the same query runs against
// a future multi-labeler deployment.
//
// Auth is not required. Labels are intentionally public — that's what
// makes the labeler addressable from any client without credentials.
//
// See chapter 24 — Ozone-shaped moderation.

import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { labels } from '~/lib/db/schema'

const MAX_LIMIT = 250
const DEFAULT_LIMIT = 50

const handler: Handler = async ({ params }) => {
  const rawPatterns = params.uriPatterns
  if (rawPatterns === undefined) {
    throw BadRequest('uriPatterns is required', 'InvalidRequest')
  }
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns
    : rawPatterns.split(',').map((s) => s.trim())
  if (patterns.length === 0) {
    throw BadRequest('uriPatterns must be non-empty', 'InvalidRequest')
  }
  if (patterns.some((p) => p.length === 0)) {
    throw BadRequest(
      'uriPatterns entries must be non-empty strings',
      'InvalidRequest',
    )
  }

  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const parsed = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw BadRequest(
        `limit must be between 1 and ${MAX_LIMIT}`,
        'InvalidRequest',
      )
    }
    limit = parsed
  }
  let cursorSeq: number | undefined
  if (params.cursor !== undefined) {
    const n = Number.parseInt(params.cursor, 10)
    if (!Number.isFinite(n) || n < 0) {
      throw BadRequest('invalid cursor', 'InvalidRequest')
    }
    cursorSeq = n
  }

  // Translate patterns to SQL: `*` suffix → LIKE 'prefix%'; bare URI →
  // exact match. We OR them together — the lexicon's described
  // semantics.
  const patternClauses = patterns.map((p) =>
    p.endsWith('*')
      ? sql`${labels.uri} LIKE ${p.slice(0, -1) + '%'}`
      : eq(labels.uri, p),
  )
  // Drizzle's `or(...args)` doesn't accept a spread of pre-built
  // conditions; wrap in raw sql for the variable-length case.
  const uriClause = patternClauses.length === 1
    ? patternClauses[0]
    : or(...(patternClauses as [typeof patternClauses[number], ...typeof patternClauses]))

  const sources = parseStringArrayParam(params.sources)

  const whereClause = and(
    uriClause,
    sources.length > 0 ? inArray(labels.src, sources) : undefined,
    // ascending seq matches the lexicon expectation (firehose order).
    cursorSeq !== undefined ? gt(labels.seq, cursorSeq) : undefined,
  )

  const rows = await db
    .select()
    .from(labels)
    .where(whereClause)
    .orderBy(labels.seq)
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.seq)
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    labels: page.map((r) => ({
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

function parseStringArrayParam(
  raw: string | string[] | undefined,
): string[] {
  if (raw === undefined) return []
  const arr = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return arr.filter((s) => s.length > 0)
}

// Mark `lt` as intentionally available for descending-pagination
// extensions in future revisions; the current ascending impl doesn't
// use it.
void lt

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.label.queryLabels'
