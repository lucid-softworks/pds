// Read-after-write for proxied `app.bsky.*` reads.
//
// Problem: when a user posts (writes to their PDS-hosted repo) and
// immediately reloads their feed, the AppView may not yet have indexed
// the new post. The AppView's response is stale-by-design — its index
// is built from the firehose, which is eventually-consistent. The
// bsky.app client then renders an empty timeline for ~1s and the user
// thinks the post didn't go through.
//
// Solution (upstream's `pipethroughReadAfterWrite`): the PDS sits in the
// proxy path and knows what's in the user's repo right now. After the
// AppView responds, the PDS:
//
//   1. Reads the AppView's `atproto-repo-rev` response header — the
//      rev of the user's repo the AppView's snapshot reflects.
//   2. Queries `records` for rows whose `rev > <that-header>` — the
//      records the AppView hasn't yet indexed.
//   3. If any exist, parses the AppView's JSON body and runs a
//      per-endpoint `munge` function that merges the local records
//      into the response.
//
// The merged response is what we return to the client. The user's own
// post shows up immediately without waiting for the AppView round-trip.
//
// This module is the infrastructure; per-endpoint munges live in
// `./munges/`. See chapter 17 — PDS vs AppView vs Relay (Read-after-write).

import { and, asc, eq, gt, type SQL } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, records, repoBlocks } from '~/lib/db/schema'
import { decode } from '~/pds/codec'

export type LocalRecord = {
  uri: string
  cid: string
  collection: string
  rkey: string
  indexedAt: string
  rev: string
  record: unknown
}

export type LocalRecords = {
  count: number
  /** The user's profile record (app.bsky.actor.profile/self), or null
   *  if absent / unchanged since the AppView's snapshot. */
  profile: LocalRecord | null
  /** Post records (app.bsky.feed.post/*) newer than the AppView's snapshot. */
  posts: LocalRecord[]
}

export type MungeArgs<T> = {
  /** The parsed JSON body returned by the AppView. */
  original: T
  /** Local records newer than the AppView's snapshot. */
  local: LocalRecords
  /** The DID of the account whose session is making the request. */
  requester: string
  /** The DID resolved to the requester's local handle (cached). */
  requesterHandle: string
}

export type MungeFn<T> = (args: MungeArgs<T>) => Promise<T> | T

/** Look up the local records strictly newer than the rev the AppView's
 *  snapshot reflects. The lexicons of interest are `app.bsky.actor.profile`
 *  and `app.bsky.feed.post`; everything else is irrelevant for the merge
 *  cases we ship. */
export async function getRecordsSinceRev(args: {
  did: string
  sinceRev: string
}): Promise<LocalRecords> {
  const conds: SQL[] = [eq(records.repoDid, args.did)]
  conds.push(gt(records.rev, args.sinceRev))
  const rows = await db
    .select({
      collection: records.collection,
      rkey: records.rkey,
      cid: records.cid,
      indexedAt: records.indexedAt,
      rev: records.rev,
    })
    .from(records)
    .where(and(...conds))
    .orderBy(asc(records.indexedAt))
  // Hydrate record bodies from repo_blocks (CBOR → JS value).
  const hydrated: LocalRecord[] = []
  for (const r of rows) {
    if (r.rev === null) continue
    if (
      r.collection !== 'app.bsky.actor.profile' &&
      r.collection !== 'app.bsky.feed.post'
    ) {
      continue
    }
    const block = await db
      .select({ bytes: repoBlocks.bytes })
      .from(repoBlocks)
      .where(
        and(eq(repoBlocks.repoDid, args.did), eq(repoBlocks.cid, r.cid)),
      )
      .limit(1)
    if (block.length === 0) continue
    const value = await decode(block[0]!.bytes).catch(() => null)
    if (value === null) continue
    hydrated.push({
      uri: `at://${args.did}/${r.collection}/${r.rkey}`,
      cid: r.cid,
      collection: r.collection,
      rkey: r.rkey,
      indexedAt: r.indexedAt.toISOString(),
      rev: r.rev,
      record: value,
    })
  }
  return {
    count: hydrated.length,
    profile: hydrated.find((r) => r.collection === 'app.bsky.actor.profile') ?? null,
    posts: hydrated.filter((r) => r.collection === 'app.bsky.feed.post'),
  }
}

/** Resolve the requester's current handle from the local accounts table.
 *  Falls back to the DID if the account isn't here (shouldn't happen on
 *  authenticated routes). */
export async function resolveRequesterHandle(did: string): Promise<string> {
  const rows = await db
    .select({ handle: accounts.handle })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  return rows[0]?.handle ?? did
}

/** Intercept an AppView response and (when its `atproto-repo-rev` header
 *  says the snapshot is behind our records) re-emit it with the local
 *  records merged in by `munge`.
 *
 *  If the response isn't JSON, has no rev header, or the local view is
 *  empty, the response passes through untouched.
 *
 *  If `munge` throws or the parse fails, we log + return the original
 *  body — better stale than broken. */
export async function applyReadAfterWrite<T>(
  upstream: Response,
  ctx: { requester: string; munge: MungeFn<T> },
): Promise<Response> {
  const rev = upstream.headers.get('atproto-repo-rev')
  if (!rev) return upstream
  const ctype = upstream.headers.get('content-type') ?? ''
  if (!/^application\/json/i.test(ctype)) return upstream

  // Pull the body now — once read we can't pass it back through.
  let bodyText: string
  try {
    bodyText = await upstream.text()
  } catch {
    return upstream
  }

  const local = await getRecordsSinceRev({
    did: ctx.requester,
    sinceRev: rev,
  })
  if (local.count === 0) {
    return new Response(bodyText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return new Response(bodyText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })
  }

  const requesterHandle = await resolveRequesterHandle(ctx.requester)
  let merged: T
  try {
    merged = await ctx.munge({
      original: parsed as T,
      local,
      requester: ctx.requester,
      requesterHandle,
    })
  } catch {
    return new Response(bodyText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })
  }

  return new Response(JSON.stringify(merged), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  })
}
