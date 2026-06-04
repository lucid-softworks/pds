// End-to-end test of the bundled moderation surface.
//
// Covers:
//   - team-lead bootstrap: createAccount with PDS_MOD_TEAM_HANDLE seeds
//     mod_team and writes the labeler.service self-record
//   - requireModerator gates: rejects un-auth, rejects non-moderator JWT,
//     accepts admin Basic, accepts moderator-DID Bearer
//   - emitEvent side effects: takedown writes records.takedown_ref and
//     mod_subject_status.takedown_event_id; reverseTakedown clears
//   - emitEvent extended events: modEventTag adds tags, modEventPriorityScore
//     writes priority_score, modEventResolveAppeal flips appeal_state
//   - queryStatuses output shape: returns the lexicon's full subjectStatusView
//     including createdAt / updatedAt / tags / priorityScore / appealed
//
// Setup mirrors admin-surface.test.ts: env vars before config loads, then
// the test-db migration runner.

process.env.PDS_ADMIN_PASSWORD = 'admin-pw-test'
process.env.PDS_MOD_TEAM_HANDLE = 'mod.test'

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import {
  accounts,
  modEvents,
  modSubjectStatus,
  modTeam,
  records,
} from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { createSessionTokens } from '~/pds/auth/session'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'
import { getModTeamLead, clearModTeamCache } from '~/pds/mod/team'

function basicAdmin(password = 'admin-pw-test'): string {
  return 'Basic ' + Buffer.from(`admin:${password}`).toString('base64')
}

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
  const query = opts.query
    ? '?' +
      Object.entries(opts.query)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')
    : ''
  const url = new URL(`http://localhost/xrpc/${nsid}${query}`)
  const init: RequestInit = { method }
  const headers: Record<string, string> = {}
  if (opts.auth) headers.authorization = opts.auth
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }
  init.headers = headers
  const req = new Request(url, init)
  const res = await dispatch(registry, nsid, req)
  const text = await res.text()
  let body: unknown = text
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

describe('moderation surface — bootstrap + emit + query', () => {
  const password = 'correct horse battery staple'
  let leadDid: string
  let aliceDid: string
  let aliceRecordUri: string
  let aliceRecordCid: string
  let aliceAccessJwt: string
  let leadAccessJwt: string

  it('createAccount mod.test → seeds mod_team as lead + writes labeler.service record', async () => {
    clearModTeamCache()
    const result = await createAccount({
      handle: 'mod.test',
      email: `mod-${Date.now()}@example.test`,
      password,
    })
    leadDid = result.did
    expect(leadDid).toMatch(/^did:plc:/)

    const teamRows = await db
      .select()
      .from(modTeam)
      .where(eq(modTeam.did, leadDid))
    // The bootstrap is lazy — fires on first getModTeamLead. Run it to
    // make the row appear (createAccount only clears the cache).
    await getModTeamLead()
    const seededRows = await db
      .select()
      .from(modTeam)
      .where(eq(modTeam.did, leadDid))
    expect(seededRows).toHaveLength(1)
    expect(seededRows[0]!.role).toBe('lead')
    void teamRows

    const recordRows = await db
      .select()
      .from(records)
      .where(
        and(
          eq(records.repoDid, leadDid),
          eq(records.collection, 'app.bsky.labeler.service'),
          eq(records.rkey, 'self'),
        ),
      )
    expect(recordRows).toHaveLength(1)

    leadAccessJwt = (await createSessionTokens(leadDid)).accessJwt
  })

  it('alice signup is a normal account (no labeler, no team row)', async () => {
    const result = await createAccount({
      handle: `alice-${Date.now()}.example.com`,
      email: `alice-${Date.now()}@example.test`,
      password,
    })
    aliceDid = result.did
    expect(aliceDid).toMatch(/^did:plc:/)

    aliceAccessJwt = (await createSessionTokens(aliceDid)).accessJwt

    const teamRows = await db
      .select()
      .from(modTeam)
      .where(eq(modTeam.did, aliceDid))
    expect(teamRows).toHaveLength(0)
  })

  it("write a post into alice's repo (subject for moderation events)", async () => {
    const res = await call('com.atproto.repo.createRecord', {
      auth: `Bearer ${aliceAccessJwt}`,
      body: {
        repo: aliceDid,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: 'a post worth moderating',
          createdAt: new Date().toISOString(),
        },
      },
    })
    expect(res.status).toBe(200)
    const body = res.body as { uri: string; cid: string }
    aliceRecordUri = body.uri
    aliceRecordCid = body.cid
  })

  it('emitEvent rejects un-auth callers', async () => {
    const res = await call('tools.ozone.moderation.emitEvent', {
      body: {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventComment',
          comment: 'no-auth attempt',
        },
        subject: {
          $type: 'com.atproto.admin.defs#repoRef',
          did: aliceDid,
        },
        createdBy: aliceDid,
      },
    })
    expect(res.status).toBe(401)
  })

  it('emitEvent rejects a non-moderator JWT', async () => {
    const res = await call('tools.ozone.moderation.emitEvent', {
      auth: `Bearer ${aliceAccessJwt}`,
      body: {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventComment',
          comment: 'non-mod attempt',
        },
        subject: {
          $type: 'com.atproto.admin.defs#repoRef',
          did: aliceDid,
        },
        createdBy: aliceDid,
      },
    })
    expect(res.status).toBe(403)
  })

  it('admin Basic emits a takedown that flips records.takedown_ref', async () => {
    const res = await call('tools.ozone.moderation.emitEvent', {
      auth: basicAdmin(),
      body: {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventTakedown',
          comment: 'test takedown',
        },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: aliceRecordUri,
          cid: aliceRecordCid,
        },
        createdBy: leadDid,
      },
    })
    expect(res.status).toBe(200)

    const rec = await db
      .select({ takedownRef: records.takedownRef })
      .from(records)
      .where(eq(records.repoDid, aliceDid))
      .limit(1)
    expect(rec[0]!.takedownRef).not.toBeNull()

    const status = await db
      .select()
      .from(modSubjectStatus)
      .where(eq(modSubjectStatus.subjectUri, aliceRecordUri))
      .limit(1)
    expect(status[0]!.takedownEventId).not.toBeNull()
  })

  it('moderator JWT can emit (createdBy must match)', async () => {
    const res = await call('tools.ozone.moderation.emitEvent', {
      auth: `Bearer ${leadAccessJwt}`,
      body: {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventTag',
          add: ['urgent'],
          comment: 'priority review',
        },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: aliceRecordUri,
          cid: aliceRecordCid,
        },
        createdBy: leadDid,
      },
    })
    expect(res.status).toBe(200)
    const events = await db
      .select()
      .from(modEvents)
      .where(eq(modEvents.eventType, 'modEventTag'))
    expect(events.length).toBeGreaterThan(0)
  })

  it('extended event types write the new mod_subject_status columns', async () => {
    // priority score
    await call('tools.ozone.moderation.emitEvent', {
      auth: basicAdmin(),
      body: {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventPriorityScore',
          score: 75,
        },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: aliceRecordUri,
          cid: aliceRecordCid,
        },
        createdBy: leadDid,
      },
    })
    // resolve appeal
    await call('tools.ozone.moderation.emitEvent', {
      auth: basicAdmin(),
      body: {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventResolveAppeal',
        },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: aliceRecordUri,
          cid: aliceRecordCid,
        },
        createdBy: leadDid,
      },
    })

    const status = await db
      .select()
      .from(modSubjectStatus)
      .where(eq(modSubjectStatus.subjectUri, aliceRecordUri))
      .limit(1)
    expect(status[0]!.priorityScore).toBe(75)
    expect(status[0]!.appealState).toBe('resolved')
    expect(status[0]!.tags).toContain('urgent')
  })

  it('queryStatuses returns the new fields in the subjectStatusView shape', async () => {
    const res = await call('tools.ozone.moderation.queryStatuses', {
      auth: basicAdmin(),
      query: { subject: aliceRecordUri },
    })
    expect(res.status).toBe(200)
    const body = res.body as {
      subjectStatuses: Array<{
        id: number
        subject: { $type: string; uri?: string; did?: string }
        reviewState: string
        takendown: boolean
        createdAt: string
        updatedAt: string
        priorityScore?: number
        tags?: string[]
        appealed?: boolean
      }>
    }
    expect(body.subjectStatuses).toHaveLength(1)
    const s = body.subjectStatuses[0]!
    expect(s.subject.uri).toBe(aliceRecordUri)
    expect(s.takendown).toBe(true)
    expect(s.createdAt).toMatch(/^\d{4}-/)
    expect(s.updatedAt).toMatch(/^\d{4}-/)
    expect(s.priorityScore).toBe(75)
    expect(s.tags).toContain('urgent')
    expect(s.appealed).toBe(true)
  })

  it('reverseTakedown clears records.takedown_ref and the cache pointer', async () => {
    const res = await call('tools.ozone.moderation.emitEvent', {
      auth: basicAdmin(),
      body: {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventReverseTakedown',
        },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: aliceRecordUri,
          cid: aliceRecordCid,
        },
        createdBy: leadDid,
      },
    })
    expect(res.status).toBe(200)
    const rec = await db
      .select({ takedownRef: records.takedownRef })
      .from(records)
      .where(eq(records.repoDid, aliceDid))
      .limit(1)
    expect(rec[0]!.takedownRef).toBeNull()
    const status = await db
      .select()
      .from(modSubjectStatus)
      .where(eq(modSubjectStatus.subjectUri, aliceRecordUri))
      .limit(1)
    expect(status[0]!.takedownEventId).toBeNull()
  })
})
