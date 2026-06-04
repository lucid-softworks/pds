// XRPC handler: com.atproto.admin.getInviteCodes
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/getInviteCodes.json
//
// Operator view of every invite code in the database. Supports `sort`
// (`recent` | `usage`), `limit` (1..500, default 100), and `cursor` for
// pagination. The output uses the lexicon's `defs#inviteCode` shape:
//
//   {
//     code,
//     available,            // uses_total (total mints we expected)
//     disabled,
//     forAccount,           // DID this code is gated to, or 'admin' if
//                           // none — matches reference convention
//     createdBy,            // DID, or 'admin' when minted by the operator
//     createdAt,            // ISO string
//     uses: [{ usedBy, usedAt }]   // redeemed-by audit rows
//   }
//
// We don't paginate `uses` per code (the reference doesn't either) — a
// heavily-redeemed code with thousands of redemptions would inflate the
// page, but that's a vanishingly rare shape in practice. Operators
// hitting that limit page through fewer outer codes instead.
//
// See chapter 19 — Moderation (invite governance).

import { asc, desc, eq, lt, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { inviteCodes, inviteCodeUses } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100

const handler: Handler = async ({ params, authorization }) => {
  await requireAdmin(authorization)

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

  const sort = params.sort?.trim() ?? 'recent'
  if (sort !== 'recent' && sort !== 'usage') {
    throw BadRequest('sort must be "recent" or "usage"', 'InvalidRequest')
  }
  const cursor = params.cursor?.trim()

  // For `recent` we paginate by created_at desc + code as the tiebreak so
  // the cursor is just the created_at ISO of the last row. For `usage`
  // we paginate by uses_total desc + code asc; the cursor encodes both
  // (`<usesTotal>:<code>`).
  const codeRows = await (sort === 'recent'
    ? db
        .select()
        .from(inviteCodes)
        .where(cursor ? lt(inviteCodes.createdAt, new Date(cursor)) : undefined)
        .orderBy(desc(inviteCodes.createdAt), asc(inviteCodes.code))
        .limit(limit + 1)
    : db
        .select()
        .from(inviteCodes)
        .where(
          cursor
            ? sql`(${inviteCodes.usesTotal}, ${inviteCodes.code}) < (${cursorUsageParts(cursor).total}, ${cursorUsageParts(cursor).code})`
            : undefined,
        )
        .orderBy(desc(inviteCodes.usesTotal), asc(inviteCodes.code))
        .limit(limit + 1))

  const page = codeRows.slice(0, limit)
  const nextCursor =
    codeRows.length > limit && page.length > 0
      ? sort === 'recent'
        ? page[page.length - 1]!.createdAt.toISOString()
        : `${page[page.length - 1]!.usesTotal}:${page[page.length - 1]!.code}`
      : undefined

  // One follow-up query for the use-by audit rows — cheaper than a join
  // since most codes have 0 or 1 redemption rows.
  const codes = page.map((r) => r.code)
  const useRows =
    codes.length > 0
      ? await db
          .select()
          .from(inviteCodeUses)
          .where(sql`${inviteCodeUses.code} = ANY(${codes})`)
      : []
  const usesByCode = new Map<string, Array<{ usedBy: string; usedAt: string }>>()
  for (const u of useRows) {
    const list = usesByCode.get(u.code) ?? []
    list.push({ usedBy: u.usedBy, usedAt: u.usedAt.toISOString() })
    usesByCode.set(u.code, list)
  }

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    codes: page.map((r) => ({
      code: r.code,
      available: r.usesTotal,
      disabled: r.disabled,
      forAccount: r.forAccount ?? 'admin',
      createdBy: r.createdBy ?? 'admin',
      createdAt: r.createdAt.toISOString(),
      uses: usesByCode.get(r.code) ?? [],
    })),
  }
}

function cursorUsageParts(cursor: string): { total: number; code: string } {
  const idx = cursor.indexOf(':')
  if (idx < 0) {
    throw BadRequest('invalid cursor for sort=usage', 'InvalidRequest')
  }
  const total = Number.parseInt(cursor.slice(0, idx), 10)
  if (!Number.isFinite(total) || total < 0) {
    throw BadRequest('invalid cursor for sort=usage', 'InvalidRequest')
  }
  return { total, code: cursor.slice(idx + 1) }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.admin.getInviteCodes'
