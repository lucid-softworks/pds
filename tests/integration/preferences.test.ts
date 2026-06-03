// app.bsky.actor.{get,put}Preferences round-trip.
//
// PDS-served methods despite the namespace — bsky.app expects its user's
// PDS to own the preference blob. Storage is a JSON-string column on
// `accounts`; the contents are opaque to the PDS (AppView + client own
// the schema), so the tests focus on persistence + access control.

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAccount } from '~/pds/account/create'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

describe('app.bsky.actor preferences', () => {
  let aliceJwt = ''
  let bobJwt = ''

  beforeAll(async () => {
    await migrateProcessDb()
    aliceJwt = (
      await createAccount({
        handle: 'alice.test',
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      })
    ).accessJwt
    bobJwt = (
      await createAccount({
        handle: 'bob.test',
        email: 'bob@example.com',
        password: 'correct-horse-battery-staple',
      })
    ).accessJwt
  })

  function req(
    nsid: string,
    method: 'GET' | 'POST',
    jwt: string,
    body?: unknown,
  ): Request {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${jwt}` },
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
      ;(init.headers as Record<string, string>)['content-type'] =
        'application/json'
    }
    return new Request(`http://localhost/xrpc/${nsid}`, init)
  }

  it('returns an empty array for a fresh account', async () => {
    const res = await dispatch(
      registry,
      'app.bsky.actor.getPreferences',
      req('app.bsky.actor.getPreferences', 'GET', aliceJwt),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ preferences: [] })
  })

  it('round-trips a valid preferences array', async () => {
    const prefs = [
      { $type: 'app.bsky.actor.defs#adultContentPref', enabled: false },
      {
        $type: 'app.bsky.actor.defs#contentLabelPref',
        label: 'nudity',
        visibility: 'warn',
      },
    ]
    const putRes = await dispatch(
      registry,
      'app.bsky.actor.putPreferences',
      req('app.bsky.actor.putPreferences', 'POST', aliceJwt, { preferences: prefs }),
    )
    expect(putRes.status).toBe(200)

    const getRes = await dispatch(
      registry,
      'app.bsky.actor.getPreferences',
      req('app.bsky.actor.getPreferences', 'GET', aliceJwt),
    )
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual({ preferences: prefs })
  })

  it("scopes preferences per account (bob doesn't see alice's)", async () => {
    const getRes = await dispatch(
      registry,
      'app.bsky.actor.getPreferences',
      req('app.bsky.actor.getPreferences', 'GET', bobJwt),
    )
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual({ preferences: [] })
  })

  it('rejects a put without `preferences` in the body', async () => {
    const res = await dispatch(
      registry,
      'app.bsky.actor.putPreferences',
      req('app.bsky.actor.putPreferences', 'POST', aliceJwt, { wrong: true }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('rejects items missing the $type tag', async () => {
    const res = await dispatch(
      registry,
      'app.bsky.actor.putPreferences',
      req('app.bsky.actor.putPreferences', 'POST', aliceJwt, {
        preferences: [{ enabled: true }],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects items whose $type is outside app.bsky.actor.defs', async () => {
    const res = await dispatch(
      registry,
      'app.bsky.actor.putPreferences',
      req('app.bsky.actor.putPreferences', 'POST', aliceJwt, {
        preferences: [{ $type: 'com.malicious.pref', exploit: true }],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects unauthenticated requests', async () => {
    const res = await dispatch(
      registry,
      'app.bsky.actor.getPreferences',
      new Request('http://localhost/xrpc/app.bsky.actor.getPreferences', {
        method: 'GET',
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
