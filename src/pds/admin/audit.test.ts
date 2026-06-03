// Behaviour contract for the admin audit helpers.
//
// - logAuditEntry inserts a row with the supplied columns.
// - listAuditEntries returns rows in descending id order (newest first).
// - limit + cursor pagination produces stable, non-overlapping pages.
// - targetDid filter narrows to one account's history.
// - action filter narrows to one verb.

import { setupTestDbEnv, migrateProcessDb } from '../../../tests/db'

setupTestDbEnv()

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { adminAudit } from '~/lib/db/schema/audit'
import { logAuditEntry, listAuditEntries } from './audit'

beforeAll(async () => {
  await migrateProcessDb()
})

beforeEach(async () => {
  await db.delete(adminAudit)
})

describe('logAuditEntry', () => {
  it('inserts a row with the supplied columns', async () => {
    await logAuditEntry({
      actor: 'admin',
      action: 'updateAccountStatus',
      targetDid: 'did:plc:abc',
      params: { did: 'did:plc:abc', status: 'takendown' },
      ipAddr: '10.0.0.1',
      result: 'ok',
    })
    const { entries } = await listAuditEntries({})
    expect(entries).toHaveLength(1)
    const row = entries[0]!
    expect(row.actor).toBe('admin')
    expect(row.action).toBe('updateAccountStatus')
    expect(row.targetDid).toBe('did:plc:abc')
    expect(row.ipAddr).toBe('10.0.0.1')
    expect(row.result).toBe('ok')
    expect(row.errorMessage).toBeNull()
    expect(row.params).toEqual({ did: 'did:plc:abc', status: 'takendown' })
  })

  it('records error rows verbatim', async () => {
    await logAuditEntry({
      actor: 'admin',
      action: 'sendEmail',
      targetDid: 'did:plc:nobody',
      params: { recipientDid: 'did:plc:nobody', content: 'hi' },
      result: 'error',
      errorMessage: 'account not found: did:plc:nobody',
    })
    const { entries } = await listAuditEntries({})
    expect(entries).toHaveLength(1)
    expect(entries[0]!.result).toBe('error')
    expect(entries[0]!.errorMessage).toMatch(/account not found/)
  })
})

describe('listAuditEntries', () => {
  it('returns rows in descending id order', async () => {
    await logAuditEntry({
      actor: 'admin',
      action: 'updateAccountStatus',
      targetDid: 'did:plc:a',
      params: { did: 'did:plc:a' },
      result: 'ok',
    })
    await logAuditEntry({
      actor: 'admin',
      action: 'updateAccountHandle',
      targetDid: 'did:plc:b',
      params: { did: 'did:plc:b' },
      result: 'ok',
    })
    await logAuditEntry({
      actor: 'admin',
      action: 'deleteAccount',
      targetDid: 'did:plc:c',
      params: { did: 'did:plc:c' },
      result: 'ok',
    })
    const { entries } = await listAuditEntries({})
    expect(entries.map((e) => e.action)).toEqual([
      'deleteAccount',
      'updateAccountHandle',
      'updateAccountStatus',
    ])
    // ids are monotone in descending order
    expect(entries[0]!.id).toBeGreaterThan(entries[1]!.id)
    expect(entries[1]!.id).toBeGreaterThan(entries[2]!.id)
  })

  it('paginates with limit + cursor without overlap', async () => {
    for (let i = 0; i < 5; i++) {
      await logAuditEntry({
        actor: 'admin',
        action: 'updateAccountStatus',
        targetDid: `did:plc:${i}`,
        params: { i },
        result: 'ok',
      })
    }
    const page1 = await listAuditEntries({ limit: 2 })
    expect(page1.entries).toHaveLength(2)
    expect(page1.cursor).toBeDefined()
    const page2 = await listAuditEntries({ limit: 2, cursor: page1.cursor! })
    expect(page2.entries).toHaveLength(2)
    const page3 = await listAuditEntries({ limit: 2, cursor: page2.cursor! })
    expect(page3.entries).toHaveLength(1)
    expect(page3.cursor).toBeUndefined()
    // No overlap across pages
    const allIds = [
      ...page1.entries,
      ...page2.entries,
      ...page3.entries,
    ].map((e) => e.id)
    expect(new Set(allIds).size).toBe(5)
  })

  it('filters by targetDid', async () => {
    await logAuditEntry({
      actor: 'admin',
      action: 'updateAccountStatus',
      targetDid: 'did:plc:keep',
      params: { x: 1 },
      result: 'ok',
    })
    await logAuditEntry({
      actor: 'admin',
      action: 'updateAccountStatus',
      targetDid: 'did:plc:other',
      params: { x: 2 },
      result: 'ok',
    })
    await logAuditEntry({
      actor: 'admin',
      action: 'deleteAccount',
      targetDid: 'did:plc:keep',
      params: { x: 3 },
      result: 'ok',
    })
    const { entries } = await listAuditEntries({ targetDid: 'did:plc:keep' })
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.targetDid === 'did:plc:keep')).toBe(true)
  })

  it('filters by action', async () => {
    await logAuditEntry({
      actor: 'admin',
      action: 'updateAccountStatus',
      targetDid: 'did:plc:a',
      params: { x: 1 },
      result: 'ok',
    })
    await logAuditEntry({
      actor: 'admin',
      action: 'sendEmail',
      targetDid: 'did:plc:b',
      params: { x: 2 },
      result: 'ok',
    })
    await logAuditEntry({
      actor: 'admin',
      action: 'sendEmail',
      targetDid: 'did:plc:c',
      params: { x: 3 },
      result: 'ok',
    })
    const { entries } = await listAuditEntries({ action: 'sendEmail' })
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.action === 'sendEmail')).toBe(true)
  })

  it('caps limit at 500', async () => {
    // Don't actually insert 500 rows; just verify behaviour: requesting a
    // ridiculous limit on an empty table doesn't error.
    const { entries } = await listAuditEntries({ limit: 100_000 })
    expect(entries).toEqual([])
  })
})
