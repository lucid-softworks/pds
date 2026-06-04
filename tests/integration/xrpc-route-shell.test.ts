// HTTP route-shell sanity test for the /xrpc/:nsid TanStack route.
//
// The existing tests dispatch directly via `dispatch(registry, nsid, req)`
// — which is correct for handler-level coverage but skips the route-
// shell parameter extraction (`params.nsid`) and the `_health`
// short-circuit. This file calls the actual Route handler so a typo
// in the param name (or someone accidentally rewiring _health) gets
// caught.

process.env.PDS_ADMIN_PASSWORD = 'admin-pw-test'
process.env.PDS_MOD_TEAM_HANDLE = 'mod.test'

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { beforeAll, describe, expect, it } from 'vitest'
import { Route } from '~/routes/xrpc/$nsid'

// The Route object exposes its `server.handlers` map. We invoke the
// GET / POST handler directly with the same shape TanStack Start
// would pass (request + params + nothing else we use).

type Handler = (args: { request: Request; params: { nsid: string } }) => Promise<Response>

const handlers = Route.options.server!.handlers as unknown as {
  GET: Handler
  POST: Handler
}
const GET = handlers.GET
const POST = handlers.POST

function basicAdmin(password = 'admin-pw-test'): string {
  return 'Basic ' + Buffer.from(`admin:${password}`).toString('base64')
}

async function call(
  handler: Handler,
  nsid: string,
  opts: { auth?: string; body?: unknown; query?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (opts.auth) headers.authorization = opts.auth
  let body: BodyInit | null = null
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const url = `http://localhost/xrpc/${nsid}${opts.query ? '?' + opts.query : ''}`
  const req = new Request(url, {
    method: body === null ? 'GET' : 'POST',
    headers,
    body,
  })
  const res = await handler({ request: req, params: { nsid } })
  const text = await res.text()
  let parsed: unknown = text
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: res.status, body: parsed }
}

beforeAll(async () => {
  await migrateProcessDb()
})

describe('/xrpc/:nsid route shell', () => {
  it('_health short-circuits with version + 200', async () => {
    const res = await call(GET, '_health')
    expect(res.status).toBe(200)
    const body = res.body as { version: string }
    expect(typeof body.version).toBe('string')
  })

  it('unknown NSID returns 404 via the dispatcher', async () => {
    const res = await call(GET, 'com.example.notARealEndpoint')
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toBe('MethodNotImplemented')
  })

  it('public GET (com.atproto.temp.fetchLabels) returns 200 through the shell', async () => {
    const res = await call(GET, 'com.atproto.temp.fetchLabels', { query: 'limit=1' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ labels: expect.any(Array) })
  })

  it('moderator-gated GET (tools.ozone.queue.listQueues) requires auth', async () => {
    const noAuth = await call(GET, 'tools.ozone.queue.listQueues')
    expect(noAuth.status).toBe(401)

    const withAuth = await call(GET, 'tools.ozone.queue.listQueues', {
      auth: basicAdmin(),
    })
    expect(withAuth.status).toBe(200)
    expect(withAuth.body).toMatchObject({ queues: expect.any(Array) })
  })

  it('moderator-gated POST (tools.ozone.report.refreshStats) reaches the handler', async () => {
    const res = await call(POST, 'tools.ozone.report.refreshStats', {
      auth: basicAdmin(),
      body: {},
    })
    expect(res.status).toBe(200)
    expect((res.body as { refreshed: boolean }).refreshed).toBe(true)
  })

  it('bsky-app proxy stubs are registered (return 401 not 404 on un-auth)', async () => {
    // Each NSID upstream serves via pipethrough — without the stub we'd
    // 404 with MethodNotImplemented; with it, we 401 on missing auth.
    const stubs: Array<[string, 'GET' | 'POST']> = [
      ['app.bsky.actor.getProfile', 'GET'],
      ['app.bsky.actor.getProfiles', 'GET'],
      ['app.bsky.feed.getAuthorFeed', 'GET'],
      ['app.bsky.feed.getTimeline', 'GET'],
      ['app.bsky.feed.getActorLikes', 'GET'],
      ['app.bsky.feed.getPostThread', 'GET'],
      ['app.bsky.feed.getFeed', 'GET'],
      ['app.bsky.notification.registerPush', 'POST'],
    ]
    for (const [nsid, method] of stubs) {
      const res = await call(
        method === 'GET' ? GET : POST,
        nsid,
        method === 'POST' ? { body: {} } : {},
      )
      expect(res.status, `${nsid} should reject un-auth before routing`).toBe(401)
    }
  })
})
