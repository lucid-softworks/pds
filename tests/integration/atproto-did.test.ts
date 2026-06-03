// /.well-known/atproto-did handle-verification round-trip.
//
// The route is keyed off the `Host` request header — a fetch to
// https://<handle>/.well-known/atproto-did returns the DID whose handle
// matches the Host. AppViews use this (in parallel with the DNS TXT
// path) to verify the handle binding claimed in a user's DID document;
// without it they show `handle.invalid`.

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '~/lib/db'
import { eq } from 'drizzle-orm'
import { accounts } from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { Route as WellKnownRoute } from '~/routes/[.well-known]/$file'

describe('/.well-known/atproto-did host-based lookup', () => {
  let aliceDid = ''

  beforeAll(async () => {
    await migrateProcessDb()
    const alice = await createAccount({
      handle: 'alice.test',
      email: 'alice@example.com',
      password: 'correct-horse-battery-staple',
    })
    aliceDid = alice.did
  })

  // The route handler is exposed via TanStack Start's createFileRoute
  // server config — invoke it directly so we don't have to stand up a
  // real HTTP server.
  const get = async (host: string): Promise<Response> => {
    const handlers = (WellKnownRoute.options as { server?: { handlers?: { GET?: (ctx: { request: Request; params: { file: string } }) => Promise<Response> } } }).server?.handlers
    if (!handlers?.GET) throw new Error('GET handler missing from route')
    const request = new Request('http://localhost/.well-known/atproto-did', {
      method: 'GET',
      headers: { host },
    })
    return await handlers.GET({ request, params: { file: 'atproto-did' } })
  }

  it("returns alice's DID when Host is her handle", async () => {
    const res = await get('alice.test')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    const body = await res.text()
    expect(body).toBe(aliceDid)
  })

  it('404s when Host is an unknown handle', async () => {
    const res = await get('nobody.test')
    expect(res.status).toBe(404)
  })

  it('404s when Host is the apex (PDS hostname, not a handle)', async () => {
    // setupTestDbEnv sets PDS_HOSTNAME to 'localhost' — the apex.
    const res = await get('localhost')
    expect(res.status).toBe(404)
  })

  it('strips the port from Host before lookup', async () => {
    // Browsers / clients commonly include the port in Host. Our handle
    // index doesn't store ports, so a literal lookup of `alice.test:443`
    // would 404 even though it's the same handle.
    const res = await get('alice.test:443')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(aliceDid)
  })

  it('treats Host case-insensitively', async () => {
    const res = await get('ALICE.TEST')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(aliceDid)
  })

  it("404s for handles whose account is takendown", async () => {
    await db
      .update(accounts)
      .set({ status: 'takendown' })
      .where(eq(accounts.handle, 'alice.test'))
    const res = await get('alice.test')
    expect(res.status).toBe(404)
  })
})
