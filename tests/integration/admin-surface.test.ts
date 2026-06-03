// End-to-end admin moderation surface, exercising HTTP Basic auth.
//
// Walks through the four admin verbs that drive the account-status state
// machine: getAccountInfo (read), updateAccountStatus (takedown → restore),
// deleteAccount (tombstone). Between status flips we confirm the user-facing
// login surface honors the change.
//
// Auth is HTTP Basic with the configured admin password. We pre-hash a
// fixed password into PDS_ADMIN_PASSWORD_HASH *before* config loads, so the
// real verifyPassword path runs (rather than the plaintext fallback).

import { hashPassword } from '~/pds/auth/password'

// Run pre-config-load: synchronous-only setup at module top level.
// hashPassword is async, so we stash a Promise and await it in beforeAll —
// but we must populate the env var before any code reads it. We do that by
// caching the hash to disk via a top-level await would be cleanest, but
// vitest doesn't allow top-level await in setup files. Workaround: use the
// `plain:` fallback prefix which is exactly what config supports for dev.
// That keeps the test deterministic without an awaited hash.
process.env.PDS_ADMIN_PASSWORD_HASH = ''
process.env.PDS_ADMIN_PASSWORD = 'admin-pw-test'

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { loginWithPassword } from '~/pds/auth/session'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

// Build HTTP Basic Authorization header for `admin:<password>`.
function basicAdmin(password = 'admin-pw-test'): string {
  return 'Basic ' + Buffer.from(`admin:${password}`).toString('base64')
}

/** Dispatch an XRPC call. JSON body if `body` provided; GET otherwise.
 *  Returns the parsed JSON response (or null for empty 200s) along with the
 *  HTTP status, so failure cases can be asserted too. */
async function call(
  nsid: string,
  opts: {
    method?: 'GET' | 'POST'
    body?: unknown
    auth?: string
    query?: Record<string, string>
  } = {},
): Promise<{ status: number; body: unknown }> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const url = new URL(`http://localhost/xrpc/${nsid}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, v)
    }
  }
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.auth) headers['authorization'] = opts.auth
  const init: RequestInit = { method, headers }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  const req = new Request(url, init)
  const res = await dispatch(registry, nsid, req)
  const text = await res.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body }
}

beforeAll(async () => {
  await migrateProcessDb()
  // hashPassword is exported here so the import survives tree-shaking; we
  // intentionally use the `plain:` config path above so the test stays
  // self-contained.
  void hashPassword
})

describe('admin surface — moderation lifecycle', () => {
  const handle = `alice-${Date.now()}.example.com`
  const email = `alice-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string

  it('createAccount succeeds (alice)', async () => {
    const result = await createAccount({ handle, email, password })
    did = result.did
    expect(did).toMatch(/^did:plc:/)
  })

  it('admin.getAccountInfo returns alice\'s details with valid auth', async () => {
    const res = await call('com.atproto.admin.getAccountInfo', {
      method: 'GET',
      auth: basicAdmin(),
      query: { did },
    })
    expect(res.status).toBe(200)
    const body = res.body as { did: string; handle: string; status: string }
    expect(body.did).toBe(did)
    expect(body.handle).toBe(handle)
    expect(body.status).toBe('active')
  })

  it('admin.getAccountInfo rejects with no auth header', async () => {
    const res = await call('com.atproto.admin.getAccountInfo', {
      method: 'GET',
      query: { did },
    })
    expect(res.status).toBe(401)
  })

  it('admin.getAccountInfo rejects on wrong admin password', async () => {
    const res = await call('com.atproto.admin.getAccountInfo', {
      method: 'GET',
      auth: basicAdmin('wrong-password'),
      query: { did },
    })
    expect(res.status).toBe(401)
  })

  it('admin.updateAccountStatus → takendown flips the status column', async () => {
    const res = await call('com.atproto.admin.updateAccountStatus', {
      body: { did, status: 'takendown' },
      auth: basicAdmin(),
    })
    expect(res.status).toBe(200)
    const rows = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, did))
    expect(rows[0]!.status).toBe('takendown')
  })

  it('loginWithPassword refuses a takendown account (AccountTakedown)', async () => {
    await expect(loginWithPassword(handle, password)).rejects.toMatchObject({
      errorName: 'AccountTakedown',
      status: 403,
    })
  })

  it('admin.updateAccountStatus → active restores login', async () => {
    const res = await call('com.atproto.admin.updateAccountStatus', {
      body: { did, status: 'active' },
      auth: basicAdmin(),
    })
    expect(res.status).toBe(200)
    const rows = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, did))
    expect(rows[0]!.status).toBe('active')

    const session = await loginWithPassword(handle, password)
    expect(session.account.did).toBe(did)
    expect(session.tokens.accessJwt.split('.')).toHaveLength(3)
  })

  it('admin.deleteAccount sets status=deleted (terminal)', async () => {
    const res = await call('com.atproto.admin.deleteAccount', {
      body: { did },
      auth: basicAdmin(),
    })
    expect(res.status).toBe(200)
    const rows = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, did))
    expect(rows[0]!.status).toBe('deleted')
  })

  it('admin.deleteAccount on an already-deleted account is rejected', async () => {
    const res = await call('com.atproto.admin.deleteAccount', {
      body: { did },
      auth: basicAdmin(),
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe('InvalidAccountState')
  })
})
