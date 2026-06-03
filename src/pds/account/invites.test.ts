// Behavior contract for invite codes.
//
// Two pinned guarantees:
//   - `generateInviteCode` emits exactly `pds-xxxxx-xxxxx` (the operator
//     pastes this into Slack; format drift would break their workflows).
//   - `reserveInviteCode` is single-shot: a code with `uses_remaining = 1`
//     can be claimed once and then fails closed on the next attempt with
//     the documented error name.
//
// The DB-backed cases use a fresh on-disk PGlite per test file: we set
// `DATABASE_URL` *before* importing `~/lib/db` (transitively, through
// `~/pds/account/invites`), so the module proxy lazy-binds to our pglite.

import { setupTestDbEnv, migrateProcessDb } from '../../../tests/db'

// IMPORTANT: must run before any import that touches `~/lib/db`.
setupTestDbEnv()

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { inviteCodes } from '~/lib/db/schema'
import { XrpcError } from '~/pds/xrpc/errors'
import {
  createOneInviteCode,
  generateInviteCode,
  peekInviteCode,
  reserveInviteCode,
} from './invites'

beforeAll(async () => {
  await migrateProcessDb()
})

afterAll(async () => {
  // PGlite holds open file handles on the temp dir; vitest's per-file
  // process pool tears them down at exit, so we don't need explicit close.
})

describe('generateInviteCode', () => {
  it('emits the <hostname>-xxxxx-xxxxx shape', () => {
    // vitest.setup.ts pins PDS_HOSTNAME to `localhost`, so the prefix is
    // simply `localhost-`.
    for (let i = 0; i < 20; i++) {
      const code = generateInviteCode()
      expect(code).toMatch(/^localhost-[a-z2-7]{5}-[a-z2-7]{5}$/)
    }
  })

  it('produces a unique value on each call', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(generateInviteCode())
    // 100 50-bit codes colliding is astronomically unlikely.
    expect(seen.size).toBe(100)
  })
})

describe('reserveInviteCode', () => {
  it('consumes a code once and fails on re-use', async () => {
    const { code } = await createOneInviteCode({ usesRemaining: 1 })

    // First reservation should succeed silently.
    await reserveInviteCode({ code, usedBy: 'did:plc:firstaaaaaaaaaaaaaaaaaaaa' })

    // The row's counter is now zero — confirm by direct read.
    const rows = await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code))
    expect(rows[0]!.usesRemaining).toBe(0)
    expect(rows[0]!.usesTotal).toBe(1)

    // Second reservation: same DID even — must fail with InvalidInviteCode.
    let err: unknown = null
    try {
      await reserveInviteCode({
        code,
        usedBy: 'did:plc:secondaaaaaaaaaaaaaaaaaaaa',
      })
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    // XrpcError exposes the lexicon-canonical tag via `errorName`.
    expect((err as XrpcError).errorName).toBe('InvalidInviteCode')
    expect((err as XrpcError).status).toBe(401)
  })

  it('peekInviteCode returns the row for a valid code', async () => {
    const { code } = await createOneInviteCode({ usesRemaining: 2 })
    const row = await peekInviteCode({ code, candidateDid: null })
    expect(row.code).toBe(code)
    expect(row.usesRemaining).toBe(2)
  })

  it('peekInviteCode rejects unknown codes', async () => {
    await expect(
      peekInviteCode({ code: 'pds-99999-99999', candidateDid: null }),
    ).rejects.toThrow()
  })
})

// `eq` is needed for the inviteCodes lookup above. Import after the env-bind.
import { eq } from 'drizzle-orm'
