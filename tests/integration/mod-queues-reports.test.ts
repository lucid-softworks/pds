// End-to-end smoke test of the queue + report surfaces.
//
// Covers:
//   - tools.ozone.queue.createQueue / listQueues / updateQueue / assignModerator
//     / unassignModerator / getAssignments / deleteQueue
//   - tools.ozone.queue.routeReports auto-assigning a matching report
//   - tools.ozone.report.queryReports / getReport / listActivities /
//     createActivity / assignModerator / unassignModerator /
//     getLiveStats / refreshStats
//
// Auth: admin Basic (the createAccount + bootstrap flows are exercised
// in mod-surface.test.ts; this file focuses on the new endpoints).

process.env.PDS_ADMIN_PASSWORD = 'admin-pw-test'
process.env.PDS_MOD_TEAM_HANDLE = 'mod.test'

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()

import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db'
import { moderationReports } from '~/lib/db/schema'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

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

describe('tools.ozone.queue.* + tools.ozone.report.*', () => {
  let queueId: number
  let reportId: number

  it('createQueue inserts an enabled queue and returns the view', async () => {
    const res = await call('tools.ozone.queue.createQueue', {
      auth: basicAdmin(),
      body: {
        name: 'spam-posts',
        subjectTypes: ['record'],
        collection: 'app.bsky.feed.post',
        reportTypes: ['com.atproto.moderation.defs#reasonSpam'],
        description: 'spam reports on posts',
      },
    })
    expect(res.status).toBe(200)
    const body = res.body as {
      queue: { id: number; name: string; enabled: boolean; stats: unknown }
    }
    expect(body.queue.name).toBe('spam-posts')
    expect(body.queue.enabled).toBe(true)
    queueId = body.queue.id
  })

  it('listQueues paginates and includes the queue we just made', async () => {
    const res = await call('tools.ozone.queue.listQueues', {
      auth: basicAdmin(),
    })
    expect(res.status).toBe(200)
    const body = res.body as {
      queues: Array<{ id: number; name: string }>
    }
    expect(body.queues.find((q) => q.id === queueId)).toBeDefined()
  })

  it('createQueue with a duplicate name → ConflictingQueue 409', async () => {
    const res = await call('tools.ozone.queue.createQueue', {
      auth: basicAdmin(),
      body: {
        name: 'spam-posts',
        subjectTypes: ['record'],
        collection: 'app.bsky.feed.post',
        reportTypes: ['com.atproto.moderation.defs#reasonSpam'],
      },
    })
    expect(res.status).toBe(409)
    expect((res.body as { error: string }).error).toBe('ConflictingQueue')
  })

  it('updateQueue toggles enabled', async () => {
    const res = await call('tools.ozone.queue.updateQueue', {
      auth: basicAdmin(),
      body: { queueId, enabled: false },
    })
    expect(res.status).toBe(200)
    const body = res.body as { queue: { enabled: boolean } }
    expect(body.queue.enabled).toBe(false)
    // restore for downstream tests
    await call('tools.ozone.queue.updateQueue', {
      auth: basicAdmin(),
      body: { queueId, enabled: true },
    })
  })

  it('assignModerator + getAssignments + unassignModerator round-trip', async () => {
    const assigned = await call('tools.ozone.queue.assignModerator', {
      auth: basicAdmin(),
      body: { queueId, did: 'did:plc:moderator123' },
    })
    expect(assigned.status).toBe(200)
    const list = await call('tools.ozone.queue.getAssignments', {
      auth: basicAdmin(),
      query: { onlyActive: 'true', queueIds: String(queueId) },
    })
    expect(list.status).toBe(200)
    const lb = list.body as { assignments: Array<{ did: string }> }
    expect(lb.assignments.some((a) => a.did === 'did:plc:moderator123')).toBe(
      true,
    )
    const unassigned = await call('tools.ozone.queue.unassignModerator', {
      auth: basicAdmin(),
      body: { queueId, did: 'did:plc:moderator123' },
    })
    expect(unassigned.status).toBe(200)
  })

  it('seed a moderation report so routeReports + report endpoints have data', async () => {
    const inserted = await db
      .insert(moderationReports)
      .values({
        reportedByDid: 'did:plc:reporterXXX',
        reasonType: 'com.atproto.moderation.defs#reasonSpam',
        reason: 'spammy',
        subjectType: 'com.atproto.repo.strongRef',
        subjectUri: 'at://did:plc:victimYYY/app.bsky.feed.post/abc',
        subjectCid: 'bafy-abc',
      })
      .returning({ id: moderationReports.id })
    reportId = inserted[0]!.id
  })

  it('routeReports auto-assigns the seeded report to the matching queue', async () => {
    const res = await call('tools.ozone.queue.routeReports', {
      auth: basicAdmin(),
      body: { startReportId: reportId, endReportId: reportId },
    })
    expect(res.status).toBe(200)
    const body = res.body as { assigned: number; unmatched: number }
    expect(body.assigned).toBe(1)
    expect(body.unmatched).toBe(0)
  })

  it('queryReports + getReport + getLatestReport return the routed report', async () => {
    const list = await call('tools.ozone.report.queryReports', {
      auth: basicAdmin(),
      query: { queueId: String(queueId) },
    })
    expect(list.status).toBe(200)
    const lb = list.body as { reports: Array<{ id: number; status: string }> }
    expect(lb.reports.some((r) => r.id === reportId)).toBe(true)

    const one = await call('tools.ozone.report.getReport', {
      auth: basicAdmin(),
      query: { id: String(reportId) },
    })
    expect(one.status).toBe(200)
    const ob = one.body as { report: { id: number } }
    expect(ob.report.id).toBe(reportId)

    const latest = await call('tools.ozone.report.getLatestReport', {
      auth: basicAdmin(),
    })
    expect(latest.status).toBe(200)
  })

  it('createActivity logs a queue activity + listActivities returns it', async () => {
    const create = await call('tools.ozone.report.createActivity', {
      auth: basicAdmin(),
      body: {
        reportId,
        activity: { $type: 'tools.ozone.report.defs#queueActivity' },
        internalNote: 'routed manually',
      },
    })
    expect(create.status).toBe(200)
    const list = await call('tools.ozone.report.listActivities', {
      auth: basicAdmin(),
      query: { reportId: String(reportId) },
    })
    expect(list.status).toBe(200)
    const lb = list.body as {
      activities: Array<{ activity: { $type: string }; internalNote?: string }>
    }
    expect(lb.activities.length).toBeGreaterThan(0)
    expect(lb.activities[0]!.internalNote).toBe('routed manually')
  })

  it('assignModerator on a report updates assigned_to_did + getAssignments lists it', async () => {
    const assign = await call('tools.ozone.report.assignModerator', {
      auth: basicAdmin(),
      body: { reportId, did: 'did:plc:moderator123' },
    })
    expect(assign.status).toBe(200)
    const get = await call('tools.ozone.report.getAssignments', {
      auth: basicAdmin(),
      query: { reportIds: String(reportId) },
    })
    expect(get.status).toBe(200)
    const gb = get.body as { assignments: Array<{ did: string }> }
    expect(gb.assignments.some((a) => a.did === 'did:plc:moderator123')).toBe(
      true,
    )
    await call('tools.ozone.report.unassignModerator', {
      auth: basicAdmin(),
      body: { reportId },
    })
  })

  it('getLiveStats + refreshStats return counters and a refresh timestamp', async () => {
    const live = await call('tools.ozone.report.getLiveStats', {
      auth: basicAdmin(),
      query: { queueId: String(queueId) },
    })
    expect(live.status).toBe(200)
    const lb = live.body as { openCount: number }
    expect(typeof lb.openCount).toBe('number')

    const refresh = await call('tools.ozone.report.refreshStats', {
      auth: basicAdmin(),
      body: {},
    })
    expect(refresh.status).toBe(200)
    expect((refresh.body as { refreshed: boolean }).refreshed).toBe(true)
  })

  it('tools.ozone.server.getConfig returns the operator-role viewer', async () => {
    const res = await call('tools.ozone.server.getConfig', {
      auth: basicAdmin(),
    })
    expect(res.status).toBe(200)
    const body = res.body as {
      pds: { url: string }
      appview: { url: string }
      viewer: { role: string }
    }
    expect(body.pds.url).toBeTruthy()
    expect(body.appview.url).toContain('bsky.app')
    expect(body.viewer.role).toBe('tools.ozone.team.defs#roleAdmin')
  })

  it('deleteQueue soft-deletes and migrates reports to a different queue', async () => {
    // Make a destination queue first.
    const dest = await call('tools.ozone.queue.createQueue', {
      auth: basicAdmin(),
      body: {
        name: 'spam-archive',
        subjectTypes: ['record'],
        collection: 'app.bsky.feed.post',
        reportTypes: ['com.atproto.moderation.defs#reasonSpam'],
      },
    })
    const destId = (dest.body as { queue: { id: number } }).queue.id

    const res = await call('tools.ozone.queue.deleteQueue', {
      auth: basicAdmin(),
      body: { queueId, migrateToQueueId: destId },
    })
    expect(res.status).toBe(200)
    const body = res.body as { deleted: boolean; reportsMigrated?: number }
    expect(body.deleted).toBe(true)
    expect(body.reportsMigrated).toBe(1)
  })
})
