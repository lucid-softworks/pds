// End-to-end account lifecycle, bypassing HTTP.
//
// This test exercises the same orchestrators the XRPC handlers do, in the
// same order a real client would hit them. It's the closest we get to a
// regression suite without standing up the TanStack Start server. The
// surface tested:
//
//   createAccount → loginWithPassword → applyWrites (create / delete) →
//   rotateRefreshToken / revokeRefreshToken.
//
// Reads use direct drizzle queries against the records table (the same
// table the read-side XRPC handlers consult), avoiding any HTTP coupling.
//
// (The FK-ordering bug this test originally surfaced was fixed by splitting
// did:plc creation into `buildGenesisPlc` (pure) + `persistGenesisPlc` (DB),
// and reordering `createAccount` to INSERT the accounts row first. A second
// issue — `putBlocks` writing outside the records-table transaction and
// deadlocking PGlite's single connection — was fixed by threading the tx
// handle through `putBlock` / `putBlocks`.)

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import {
  accounts,
  records as recordsTable,
  refreshTokens,
  repos,
} from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { verifyAccessToken } from '~/pds/auth/jwt'
import {
  loginWithPassword,
  revokeRefreshToken,
  rotateRefreshToken,
} from '~/pds/auth/session'
import { applyWrites } from '~/pds/repo/writes'

beforeAll(async () => {
  await migrateProcessDb()
})

describe('test harness sanity', () => {
  it('migrations applied (accounts table exists and is empty)', async () => {
    const rows = await db.select().from(accounts)
    expect(rows).toEqual([])
  })

  it('refresh_tokens, repos, and records tables exist (smoke)', async () => {
    expect(await db.select().from(refreshTokens)).toEqual([])
    expect(await db.select().from(repos)).toEqual([])
    expect(await db.select().from(recordsTable)).toEqual([])
  })
})

// See file header — skipped pending a fix to createAccount's insert order.
// eslint-disable-next-line vitest/no-disabled-tests
describe('end-to-end account lifecycle', () => {
  const handle = `alice-${Date.now()}.example.com`
  const email = `alice-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string
  let initialAccessJwt: string
  let initialRefreshJwt: string

  it('createAccount returns a DID + token pair', async () => {
    const result = await createAccount({ handle, email, password })
    did = result.did
    initialAccessJwt = result.accessJwt
    initialRefreshJwt = result.refreshJwt
    expect(did).toMatch(/^did:plc:/)
    expect(result.handle).toBe(handle)
    expect(initialAccessJwt.split('.')).toHaveLength(3)
    expect(initialRefreshJwt.split('.')).toHaveLength(3)

    const rows = await db.select().from(accounts).where(eq(accounts.did, did))
    expect(rows[0]).toBeDefined()
    expect(rows[0]!.handle).toBe(handle)
    expect(rows[0]!.status).toBe('active')

    const repoRows = await db.select().from(repos).where(eq(repos.did, did))
    expect(repoRows[0]).toBeDefined()
    expect(repoRows[0]!.rev).toMatch(/^[a-z2-7]{13}$/)
  })

  it('loginWithPassword issues fresh tokens for the same credentials', async () => {
    const { account, tokens } = await loginWithPassword(handle, password)
    expect(account.did).toBe(did)
    expect(tokens.accessJwt).not.toBe(initialAccessJwt)
    expect(tokens.refreshJwt).not.toBe(initialRefreshJwt)
    const claims = await verifyAccessToken(tokens.accessJwt)
    expect(claims.sub).toBe(did)
  })

  it('verifyAccessToken on the createAccount JWT returns the DID', async () => {
    const claims = await verifyAccessToken(initialAccessJwt)
    expect(claims.sub).toBe(did)
    expect(claims.scope).toBe('com.atproto.access')
  })

  let createdUri: string
  let createdCid: string

  it('applyWrites can create a record', async () => {
    const result = await applyWrites({
      did,
      writes: [
        {
          action: 'create',
          collection: 'app.bsky.feed.post',
          value: {
            $type: 'app.bsky.feed.post',
            text: 'hello from the integration test',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
      ],
    })
    expect(result.writes).toHaveLength(1)
    const w = result.writes[0]!
    expect(w.action).toBe('create')
    expect(w.uri).toMatch(new RegExp(`^at://${did}/app\\.bsky\\.feed\\.post/`))
    expect(w.cid).not.toBeNull()
    createdUri = w.uri
    createdCid = w.cid!.toString()

    const rkey = w.uri.split('/').pop()!
    const rows = await db
      .select()
      .from(recordsTable)
      .where(
        and(
          eq(recordsTable.repoDid, did),
          eq(recordsTable.collection, 'app.bsky.feed.post'),
          eq(recordsTable.rkey, rkey),
        ),
      )
    expect(rows[0]).toBeDefined()
    expect(rows[0]!.cid).toBe(createdCid)
  })

  it('the same record is visible via the records index (listRecords proxy)', async () => {
    const rows = await db
      .select()
      .from(recordsTable)
      .where(
        and(
          eq(recordsTable.repoDid, did),
          eq(recordsTable.collection, 'app.bsky.feed.post'),
        ),
      )
    expect(rows.map((r) => r.cid)).toContain(createdCid)
  })

  it('applyWrites can delete a record', async () => {
    const rkey = createdUri.split('/').pop()!
    const result = await applyWrites({
      did,
      writes: [
        {
          action: 'delete',
          collection: 'app.bsky.feed.post',
          rkey,
        },
      ],
    })
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]!.action).toBe('delete')
    expect(result.writes[0]!.cid).toBeNull()

    const rows = await db
      .select()
      .from(recordsTable)
      .where(
        and(
          eq(recordsTable.repoDid, did),
          eq(recordsTable.collection, 'app.bsky.feed.post'),
          eq(recordsTable.rkey, rkey),
        ),
      )
    expect(rows).toHaveLength(0)
  })

  it('rotateRefreshToken issues a new pair and invalidates the old jti', async () => {
    const { did: rotatedDid, tokens } = await rotateRefreshToken(
      initialRefreshJwt,
    )
    expect(rotatedDid).toBe(did)
    expect(tokens.refreshJwt).not.toBe(initialRefreshJwt)
    await expect(rotateRefreshToken(initialRefreshJwt)).rejects.toThrow()
  })

  it('revokeRefreshToken makes a refresh JWT unusable', async () => {
    const fresh = await loginWithPassword(handle, password)
    await revokeRefreshToken(fresh.tokens.refreshJwt)
    await expect(rotateRefreshToken(fresh.tokens.refreshJwt)).rejects.toThrow()
  })
})
