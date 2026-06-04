// GET  /mod/reports — paginated list of moderation reports with filters
// POST /mod/reports — apply an action: `assign` / `unassign` / `reassign-queue`
//                    / `note` (adds a note activity).
//
// Sibling of /mod/events: events shows operator-emitted actions on
// subjects; reports shows the user-side reports that drive those
// actions. The two surfaces meet at `mod_report_resolution` — when a
// closing event (takedown / acknowledge / divert) fires on a subject
// with open reports, those reports get a resolution row.

import { createFileRoute } from '@tanstack/react-router'
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { db } from '~/lib/db'
import {
  moderationReports,
  modQueues,
  modReportActivities,
  modReportResolution,
} from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import { renderModPage, renderModNotProvisioned, escape } from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'
import { deriveStatus } from '~/pds/mod/report'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const PAGE_LIMIT = 50

export const Route = createFileRoute('/mod/reports')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const url = new URL(request.url)
        const filters = {
          status: url.searchParams.get('status') ?? '',
          queueId: url.searchParams.get('queueId') ?? '',
          assignedTo: url.searchParams.get('assignedTo') ?? '',
          subject: url.searchParams.get('subject') ?? '',
        }
        const cursor = url.searchParams.get('cursor') ?? ''

        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Reports',
          currentPath: '/mod/reports',
          signedInAs: { handle: session.handle, role: session.role },
          body: await renderListBody(filters, cursor, csrf),
        })
        if (csrfCookie) res.headers.set('set-cookie', csrfCookie)
        return res
      },

      POST: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const form = await request.formData()
        const csrf = form.get('csrf')
        if (typeof csrf !== 'string' || !verifyCsrf(request, csrf)) {
          return badRequest('session expired, try again')
        }
        const reportId = Number.parseInt(String(form.get('reportId') ?? ''), 10)
        if (!Number.isFinite(reportId)) return badRequest('reportId required')

        const action = String(form.get('action') ?? '')
        const createdBy = session.role === 'admin' ? 'admin' : session.did
        let flash: { kind: 'ok' | 'error'; message: string } | null = null

        try {
          // Record previous status before mutating so the activity log
          // captures the transition.
          const rows = await db
            .select()
            .from(moderationReports)
            .where(eq(moderationReports.id, reportId))
            .limit(1)
          if (rows.length === 0) throw new Error(`report ${reportId} not found`)
          const previousStatus = await deriveStatus(rows[0]!)

          if (action === 'assign') {
            const did = String(form.get('did') ?? '').trim()
            if (!did) throw new Error('did required')
            await pg
              .update(moderationReports)
              .set({ assignedToDid: did, assignedAt: new Date() })
              .where(eq(moderationReports.id, reportId))
            await db.insert(modReportActivities).values({
              reportId,
              activityType: 'assignment',
              previousStatus,
              meta: { did },
              createdBy,
            })
            flash = { kind: 'ok', message: `assigned to ${did}` }
          } else if (action === 'unassign') {
            await pg
              .update(moderationReports)
              .set({ assignedToDid: null, assignedAt: null })
              .where(eq(moderationReports.id, reportId))
            await db.insert(modReportActivities).values({
              reportId,
              activityType: 'assignment',
              previousStatus,
              meta: { unassigned: true },
              createdBy,
            })
            flash = { kind: 'ok', message: 'unassigned' }
          } else if (action === 'reassign-queue') {
            const queueId = Number.parseInt(
              String(form.get('queueId') ?? ''),
              10,
            )
            if (!Number.isFinite(queueId)) throw new Error('queueId required')
            await pg
              .update(moderationReports)
              .set({ queueId })
              .where(eq(moderationReports.id, reportId))
            await db.insert(modReportActivities).values({
              reportId,
              activityType: 'queue',
              previousStatus,
              meta: { queueId },
              createdBy,
            })
            flash = { kind: 'ok', message: `routed to queue ${queueId}` }
          } else if (action === 'note') {
            const internalNote = String(form.get('internalNote') ?? '').trim()
            if (!internalNote) throw new Error('note text required')
            await db.insert(modReportActivities).values({
              reportId,
              activityType: 'note',
              previousStatus,
              internalNote,
              createdBy,
            })
            flash = { kind: 'ok', message: 'note added' }
          } else {
            throw new Error(`unknown action: ${action}`)
          }
        } catch (err) {
          flash = { kind: 'error', message: (err as Error).message }
        }

        // Re-render the same list (preserving query string) so the
        // moderator sees the updated state.
        const url = new URL(request.url)
        const filters = {
          status: url.searchParams.get('status') ?? '',
          queueId: url.searchParams.get('queueId') ?? '',
          assignedTo: url.searchParams.get('assignedTo') ?? '',
          subject: url.searchParams.get('subject') ?? '',
        }
        const { token: csrfNew, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Reports',
          currentPath: '/mod/reports',
          signedInAs: { handle: session.handle, role: session.role },
          flash,
          body: await renderListBody(filters, '', csrfNew),
        })
        if (csrfCookie) res.headers.set('set-cookie', csrfCookie)
        return res
      },
    },
  },
})

async function renderListBody(
  filters: {
    status: string
    queueId: string
    assignedTo: string
    subject: string
  },
  cursor: string,
  csrf: string,
): Promise<string> {
  const conds = []
  if (filters.queueId) {
    const n = Number.parseInt(filters.queueId, 10)
    if (Number.isFinite(n)) conds.push(eq(moderationReports.queueId, n))
  }
  if (filters.assignedTo) {
    conds.push(eq(moderationReports.assignedToDid, filters.assignedTo))
  }
  if (filters.subject) {
    if (filters.subject.startsWith('at://')) {
      conds.push(eq(moderationReports.subjectUri, filters.subject))
    } else {
      conds.push(eq(moderationReports.subjectDid, filters.subject))
    }
  }
  if (cursor) {
    const d = new Date(cursor)
    if (!isNaN(d.getTime())) conds.push(lt(moderationReports.createdAt, d))
  }

  const reports = await db
    .select()
    .from(moderationReports)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(moderationReports.createdAt))
    .limit(PAGE_LIMIT + 1)

  // Derive statuses in parallel (one cheap SQL per row for the joins).
  const withStatus = await Promise.all(
    reports.slice(0, PAGE_LIMIT).map(async (r) => ({
      ...r,
      _status: await deriveStatus(r),
    })),
  )
  // Client-side status filter (after derivation since status is a derived field)
  const filtered = filters.status
    ? withStatus.filter((r) => r._status === filters.status)
    : withStatus

  // Queue name lookup.
  const queueIds = [
    ...new Set(filtered.map((r) => r.queueId).filter((id): id is number => id !== null)),
  ]
  const queueMap = new Map<number, string>()
  if (queueIds.length > 0) {
    const qs = await db
      .select({ id: modQueues.id, name: modQueues.name })
      .from(modQueues)
      .where(inArray(modQueues.id, queueIds))
    for (const q of qs) queueMap.set(q.id, q.name)
  }

  // Latest activity per visible report.
  const activitiesByReport = new Map<number, number>()
  if (filtered.length > 0) {
    const acts = await db
      .select({
        reportId: modReportActivities.reportId,
        count: sql<number>`count(*)::int`,
      })
      .from(modReportActivities)
      .where(
        inArray(
          modReportActivities.reportId,
          filtered.map((r) => r.id),
        ),
      )
      .groupBy(modReportActivities.reportId)
    for (const a of acts) activitiesByReport.set(a.reportId, a.count)
  }

  const queues = await db
    .select({ id: modQueues.id, name: modQueues.name })
    .from(modQueues)
    .where(isNull(modQueues.deletedAt))
    .orderBy(asc(modQueues.name))

  const filterRow = `
<form method="GET" action="/mod/reports" class="form">
  <label><span>Status</span><select name="status">
    <option value=""${filters.status === '' ? ' selected' : ''}>all</option>
    ${['open', 'queued', 'assigned', 'escalated', 'closed']
      .map((s) => `<option value="${s}"${filters.status === s ? ' selected' : ''}>${s}</option>`)
      .join('')}
  </select></label>
  <label><span>Queue</span><select name="queueId">
    <option value=""${filters.queueId === '' ? ' selected' : ''}>all</option>
    ${queues
      .map(
        (q) =>
          `<option value="${q.id}"${filters.queueId === String(q.id) ? ' selected' : ''}>${escape(q.name)}</option>`,
      )
      .join('')}
  </select></label>
  <label><span>Assigned to (DID)</span><input type="text" name="assignedTo" value="${escape(filters.assignedTo)}"></label>
  <label><span>Subject (DID or AT-URI)</span><input type="text" name="subject" value="${escape(filters.subject)}"></label>
  <button type="submit" class="primary">Filter</button>
  <a href="/mod/reports" class="muted">reset</a>
</form>`

  const body = filtered.length === 0
    ? '<p class="muted">No reports match these filters.</p>'
    : `<table>
<thead><tr><th>ID</th><th>Reported</th><th>Reason</th><th>Subject</th><th>By</th><th>Status</th><th>Queue</th><th>Assignee</th><th>Activity</th><th></th></tr></thead>
<tbody>${filtered
        .map(
          (r) => `<tr>
  <td><code>${r.id}</code></td>
  <td class="mono" style="font-size: 11px;">${escape(r.createdAt.toISOString().slice(0, 16).replace('T', ' '))}</td>
  <td class="mono" style="font-size: 11px;">${escape(r.reasonType.replace('com.atproto.moderation.defs#reason', ''))}</td>
  <td class="mono" style="font-size: 11px;">${escape(r.subjectUri ?? r.subjectDid ?? '')}</td>
  <td class="mono" style="font-size: 11px;">${escape(r.reportedByDid)}</td>
  <td>${statusPill(r._status)}</td>
  <td class="mono" style="font-size: 11px;">${r.queueId !== null ? escape(queueMap.get(r.queueId) ?? String(r.queueId)) : '<span class="muted">—</span>'}</td>
  <td class="mono" style="font-size: 11px;">${r.assignedToDid ? escape(r.assignedToDid) : '<span class="muted">—</span>'}</td>
  <td>${activitiesByReport.get(r.id) ?? 0}</td>
  <td>
    <details>
      <summary style="cursor: pointer; font-size: 11px;">act</summary>
      <div style="margin-top: 0.5rem;">
        <form method="POST" action="/mod/reports" class="inline-form">
          <input type="hidden" name="csrf" value="${escape(csrf)}">
          <input type="hidden" name="action" value="assign">
          <input type="hidden" name="reportId" value="${r.id}">
          <input type="text" name="did" placeholder="did:plc:..." required style="width: 18rem; font-size: 11px;">
          <button type="submit" style="padding: 0.2rem 0.6rem; font-size: 11px;">assign</button>
        </form>
        ${r.assignedToDid ? `
        <form method="POST" action="/mod/reports" class="inline-form" style="margin-top: 0.25rem;">
          <input type="hidden" name="csrf" value="${escape(csrf)}">
          <input type="hidden" name="action" value="unassign">
          <input type="hidden" name="reportId" value="${r.id}">
          <button type="submit" style="padding: 0.2rem 0.6rem; font-size: 11px;">unassign</button>
        </form>` : ''}
        <form method="POST" action="/mod/reports" class="inline-form" style="margin-top: 0.25rem;">
          <input type="hidden" name="csrf" value="${escape(csrf)}">
          <input type="hidden" name="action" value="reassign-queue">
          <input type="hidden" name="reportId" value="${r.id}">
          <select name="queueId" required style="font-size: 11px;">
            ${queues.map((q) => `<option value="${q.id}">${escape(q.name)}</option>`).join('')}
          </select>
          <button type="submit" style="padding: 0.2rem 0.6rem; font-size: 11px;">route</button>
        </form>
        <form method="POST" action="/mod/reports" class="inline-form" style="margin-top: 0.25rem;">
          <input type="hidden" name="csrf" value="${escape(csrf)}">
          <input type="hidden" name="action" value="note">
          <input type="hidden" name="reportId" value="${r.id}">
          <input type="text" name="internalNote" placeholder="internal note..." required style="width: 18rem; font-size: 11px;">
          <button type="submit" style="padding: 0.2rem 0.6rem; font-size: 11px;">note</button>
        </form>
      </div>
    </details>
  </td>
</tr>`,
        )
        .join('')}</tbody>
</table>`

  const nextCursor =
    reports.length > PAGE_LIMIT && filtered.length > 0
      ? filtered[filtered.length - 1]!.createdAt.toISOString()
      : null
  const nextLink = nextCursor
    ? `<p class="muted"><a href="/mod/reports?${buildQuery(filters, nextCursor)}">Older reports →</a></p>`
    : ''

  return `
<header>
  <p class="kicker">Moderation</p>
  <h1>Reports</h1>
  <p class="muted">User-side reports. Status is derived from <code>mod_report_resolution</code> + <code>mod_subject_status</code> joins (no status column on the report row itself; the activity log is the audit trail).</p>
</header>
${filterRow}
${body}
${nextLink}
`
}

function statusPill(status: string): string {
  const cls =
    status === 'closed'
      ? 'pill-ok'
      : status === 'escalated'
        ? 'pill-warn'
        : ''
  return `<span class="pill ${cls}">${escape(status)}</span>`
}

function buildQuery(
  filters: { status: string; queueId: string; assignedTo: string; subject: string },
  cursor: string,
): string {
  const parts: string[] = []
  if (filters.status) parts.push(`status=${encodeURIComponent(filters.status)}`)
  if (filters.queueId) parts.push(`queueId=${encodeURIComponent(filters.queueId)}`)
  if (filters.assignedTo) parts.push(`assignedTo=${encodeURIComponent(filters.assignedTo)}`)
  if (filters.subject) parts.push(`subject=${encodeURIComponent(filters.subject)}`)
  parts.push(`cursor=${encodeURIComponent(cursor)}`)
  return parts.join('&')
}

function mintOrReuseCsrf(request: Request): {
  token: string
  setCookieHeader: string
} {
  const existing = readCookie(request, MOD_CSRF_COOKIE)
  return existing
    ? { token: existing, setCookieHeader: '' }
    : mintCsrfToken()
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = `/mod/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`
  return new Response(null, { status: 303, headers: { location: target } })
}

function badRequest(message: string): Response {
  return new Response(`bad request: ${message}`, {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
