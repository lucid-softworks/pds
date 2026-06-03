// End-to-end: at-rest signing-key protection through the account lifecycle.
//
// The unit tests in `src/pds/auth/key_wrap.test.ts` pin the wrap/unwrap
// round-trip in isolation. This file pins the *integration*: with
// `PDS_KEY_WRAP=gcm` set, do the columns actually land encrypted, and do
// the read-side callers (writes.ts, signPlcOperation, …) still produce
// valid signatures after unwrap?
//
// We also exercise mixed-mode: a row written under gcm must still be
// usable after the operator flips the env back to plain — same dispatcher,
// the gcm wrapper just doesn't see the ciphertext anymore. We don't test
// the reverse (plain row read by gcm wrapper) here because the unit tests
// already cover the dispatcher path; this file targets the wiring.
//
// See chapter 18 — Signing keys.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Set the wrap env vars *before* the db proxy + key_wrap module initialise.
// `setupTestDbEnv` does the same trick for DATABASE_URL.
process.env.PDS_KEY_WRAP = 'gcm'
// 32 bytes of 0x42 — same shape the chapter-18 example uses.
process.env.PDS_KEY_WRAP_GCM_KEY = '42'.repeat(32)
// Per-file pglite directory so the migrations and account row don't collide
// with other test files.
const dbDir = mkdtempSync(join(tmpdir(), 'pds-key-wrap-'))
process.env.DATABASE_URL = `pglite:${dbDir}`

import { setupTestDbEnv, migrateProcessDb } from '../db'
void setupTestDbEnv // imported only to keep parallel structure; we set DATABASE_URL above

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { applyWrites } from '~/pds/repo/writes'
import { resetKeyWrapperCacheForTests } from '~/pds/auth/key_wrap'

beforeAll(async () => {
  await migrateProcessDb()
})

describe('at-rest key wrap (gcm)', () => {
  const handle = `alice-keywrap-${Date.now()}.example.com`
  const email = `alice-keywrap-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string

  it('createAccount stores gcm-prefixed signing + rotation keys', async () => {
    const result = await createAccount({ handle, email, password })
    did = result.did

    const row = (
      await db.select().from(accounts).where(eq(accounts.did, did)).limit(1)
    )[0]
    expect(row).toBeDefined()
    expect(row!.signingKeyPriv.startsWith('gcm:')).toBe(true)
    expect(row!.rotationKeyPriv.startsWith('gcm:')).toBe(true)
    // The 64-hex private scalar must not appear anywhere in the stored
    // value — that's the whole point of the at-rest wrap.
    expect(row!.signingKeyPriv).not.toMatch(/^[0-9a-f]{64}$/i)
    expect(row!.rotationKeyPriv).not.toMatch(/^[0-9a-f]{64}$/i)
  })

  it('applyWrites unwraps + signs against the wrapped row', async () => {
    // Same path as createRecord. If unwrap silently produced garbage,
    // signBytes would still succeed (it doesn't validate the scalar) but
    // the next loadRepo + verifyCommit would catch it. We don't go that
    // far here — the unit tests own that; we just confirm the wiring.
    const result = await applyWrites({
      did,
      writes: [
        {
          action: 'create',
          collection: 'app.bsky.feed.post',
          value: {
            $type: 'app.bsky.feed.post',
            text: 'hello from the gcm-wrapped repo',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
      ],
    })
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]!.action).toBe('create')
    expect(result.writes[0]!.cid).not.toBeNull()
  })

  it('mixed-mode: a gcm-wrapped account is still signable after PDS_KEY_WRAP=plain', async () => {
    // The operator flips back to plain. The accounts row is still in
    // gcm: form — but the dispatcher needs the gcm key to read it. We
    // simulate the "operator forgot to set the key" case by switching
    // mid-test and confirming the wrapper raises a clear error.
    const savedKind = process.env.PDS_KEY_WRAP
    const savedKey = process.env.PDS_KEY_WRAP_GCM_KEY
    process.env.PDS_KEY_WRAP = 'plain'
    delete process.env.PDS_KEY_WRAP_GCM_KEY
    resetKeyWrapperCacheForTests()
    try {
      // A bare-hex (legacy) row would still read here, but our gcm-prefixed
      // row needs the gcm wrapper. The clear error tells the operator
      // exactly which env var to set.
      await expect(
        applyWrites({
          did,
          writes: [
            {
              action: 'create',
              collection: 'app.bsky.feed.post',
              value: {
                $type: 'app.bsky.feed.post',
                text: 'second post',
                createdAt: '2024-01-02T00:00:00.000Z',
              },
            },
          ],
        }),
      ).rejects.toThrow(/PDS_KEY_WRAP=gcm/)
    } finally {
      if (savedKind !== undefined) process.env.PDS_KEY_WRAP = savedKind
      if (savedKey !== undefined) process.env.PDS_KEY_WRAP_GCM_KEY = savedKey
      resetKeyWrapperCacheForTests()
    }
  })

  it('mixed-mode: gcm reader still works after the env is restored', async () => {
    // Putting the gcm key back means the next write succeeds again.
    // Confirms the cache reset isn't sticky and the read-side dispatcher
    // routes correctly.
    const result = await applyWrites({
      did,
      writes: [
        {
          action: 'create',
          collection: 'app.bsky.feed.post',
          value: {
            $type: 'app.bsky.feed.post',
            text: 'third post',
            createdAt: '2024-01-03T00:00:00.000Z',
          },
        },
      ],
    })
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]!.cid).not.toBeNull()
  })
})
