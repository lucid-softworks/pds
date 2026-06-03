// End-to-end records flow through the HTTP dispatcher.
//
// Differs from the orchestrator-only integration test by going through the
// real XRPC `dispatch` function, including:
//
//   - JSON body parse
//   - Authorization Bearer parsing
//   - lexicon-bridge inbound/outbound validation
//   - the handler's hand-rolled zod schema
//
// So if any of those layers regress (e.g. content-type sniffing breaks JSON
// reads), this test fails where the orchestrator-only test wouldn't.

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { records as recordsTable } from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

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
})

describe('records via HTTP dispatcher', () => {
  const handle = `charlie-${Date.now()}.example.com`
  const email = `charlie-${Date.now()}@example.test`
  const password = 'correct horse battery staple'

  let did: string
  let accessJwt: string
  let createdUri: string
  let createdRkey: string

  it('createAccount returns a DID + access JWT', async () => {
    const result = await createAccount({ handle, email, password })
    did = result.did
    accessJwt = result.accessJwt
    expect(did).toMatch(/^did:plc:/)
    expect(accessJwt.split('.')).toHaveLength(3)
  })

  it('createRecord via dispatcher writes a record', async () => {
    const res = await call('com.atproto.repo.createRecord', {
      auth: `Bearer ${accessJwt}`,
      body: {
        repo: did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: 'hello from the http-dispatcher test',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    })
    expect(res.status).toBe(200)
    const body = res.body as { uri: string; cid: string }
    expect(body.uri).toMatch(new RegExp(`^at://${did}/app\\.bsky\\.feed\\.post/`))
    expect(body.cid).toMatch(/^bafyr/)
    createdUri = body.uri
    createdRkey = createdUri.split('/').pop()!

    // Confirm the record landed in the index too.
    const rows = await db
      .select()
      .from(recordsTable)
      .where(
        and(
          eq(recordsTable.repoDid, did),
          eq(recordsTable.collection, 'app.bsky.feed.post'),
          eq(recordsTable.rkey, createdRkey),
        ),
      )
    expect(rows).toHaveLength(1)
  })

  it('createRecord without an Authorization header is 401', async () => {
    const res = await call('com.atproto.repo.createRecord', {
      body: {
        repo: did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: 'unauthorized',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    })
    expect(res.status).toBe(401)
  })

  it('getRecord via dispatcher returns the just-created record', async () => {
    const res = await call('com.atproto.repo.getRecord', {
      method: 'GET',
      query: {
        repo: did,
        collection: 'app.bsky.feed.post',
        rkey: createdRkey,
      },
    })
    expect(res.status).toBe(200)
    const body = res.body as { uri: string; cid: string; value: { text?: unknown } }
    expect(body.uri).toBe(createdUri)
    expect(body.value.text).toBe('hello from the http-dispatcher test')
  })

  it('getRecord on a non-existent rkey returns 404 / RecordNotFound', async () => {
    const res = await call('com.atproto.repo.getRecord', {
      method: 'GET',
      query: {
        repo: did,
        collection: 'app.bsky.feed.post',
        rkey: 'thiskeydoesnotexist',
      },
    })
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toBe('RecordNotFound')
  })

  it('deleteRecord via dispatcher removes the record', async () => {
    const res = await call('com.atproto.repo.deleteRecord', {
      auth: `Bearer ${accessJwt}`,
      body: {
        repo: did,
        collection: 'app.bsky.feed.post',
        rkey: createdRkey,
      },
    })
    expect(res.status).toBe(200)
    const rows = await db
      .select()
      .from(recordsTable)
      .where(
        and(
          eq(recordsTable.repoDid, did),
          eq(recordsTable.rkey, createdRkey),
        ),
      )
    expect(rows).toHaveLength(0)
  })

  it('unknown NSID is 404 / MethodNotImplemented', async () => {
    const res = await call('com.example.nope', { method: 'GET' })
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toBe('MethodNotImplemented')
  })

  it('method mismatch (GET on a POST endpoint) is 400 / InvalidRequest', async () => {
    const res = await call('com.atproto.repo.createRecord', {
      method: 'GET',
      auth: `Bearer ${accessJwt}`,
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('InvalidRequest')
  })
})
