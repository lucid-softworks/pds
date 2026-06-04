// GET /mod — dashboard.
//
// Shows a small set of counts + the most recent moderation reports +
// the most recent events. Deep links into /mod/subject and /mod/events
// for the full surfaces.

import { createFileRoute } from '@tanstack/react-router'
import { count, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import {
  modEvents,
  modReportResolution,
  modSubjectStatus,
  moderationReports,
} from '~/lib/db/schema'
import { readModSession } from '~/lib/mod-ui/auth'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'

export const Route = createFileRoute('/mod/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const [counts, recentReports, recentEvents] = await Promise.all([
          loadCounts(),
          db
            .select({
              id: moderationReports.id,
              reportedBy: moderationReports.reportedByDid,
              reasonType: moderationReports.reasonType,
              subjectType: moderationReports.subjectType,
              subjectDid: moderationReports.subjectDid,
              subjectUri: moderationReports.subjectUri,
              createdAt: moderationReports.createdAt,
            })
            .from(moderationReports)
            .orderBy(desc(moderationReports.createdAt))
            .limit(10),
          db
            .select({
              id: modEvents.id,
              eventType: modEvents.eventType,
              subjectDid: modEvents.subjectDid,
              subjectUri: modEvents.subjectUri,
              createdByDid: modEvents.createdByDid,
              createdAt: modEvents.createdAt,
            })
            .from(modEvents)
            .orderBy(desc(modEvents.id))
            .limit(10),
        ])

        const body = `
<header>
  <p class="kicker">Moderation</p>
  <h1>Dashboard</h1>
  <p class="muted">Lead: <code>${escape(counts.leadHandle ?? '(unset)')}</code> · ${escape(counts.teamSize)} team member${counts.teamSize === 1 ? '' : 's'}</p>
</header>

<div class="grid grid-4">
  <div class="card">
    <div class="stat-label">Open reports</div>
    <div class="stat-value">${counts.openReports}</div>
    <div class="stat-sub">${counts.totalReports} total</div>
  </div>
  <div class="card">
    <div class="stat-label">Active takedowns</div>
    <div class="stat-value">${counts.activeTakedowns}</div>
    <div class="stat-sub">subjects currently in force</div>
  </div>
  <div class="card">
    <div class="stat-label">Events</div>
    <div class="stat-value">${counts.totalEvents}</div>
    <div class="stat-sub">in mod_events log</div>
  </div>
  <div class="card">
    <div class="stat-label">Labels</div>
    <div class="stat-value">${counts.totalLabels}</div>
    <div class="stat-sub">signed and served via /xrpc/com.atproto.label.queryLabels</div>
  </div>
</div>

<h2>Subject lookup</h2>
<form action="/mod/subject" method="GET" class="form">
  <label>
    <span>DID or AT-URI</span>
    <input type="text" name="q" placeholder="did:plc:... or at://did:plc:.../app.bsky.feed.post/..." required>
  </label>
  <button type="submit" class="primary">Open</button>
</form>

<h2>Recent reports <a href="/mod/events?types=tools.ozone.moderation.defs%23modEventReport" style="font-size: 12px; font-weight: 400; margin-left: 0.5rem;">see all →</a></h2>
${
  recentReports.length === 0
    ? '<p class="muted">No reports yet.</p>'
    : `<table>
  <thead><tr><th>When</th><th>Subject</th><th>Reason</th><th>Reporter</th></tr></thead>
  <tbody>
  ${recentReports
    .map(
      (r) => `
    <tr>
      <td class="mono">${escape(formatRelativeTime(r.createdAt))}</td>
      <td class="mono">${subjectLink(r)}</td>
      <td class="mono">${escape(r.reasonType)}</td>
      <td class="mono">${escape(r.reportedBy)}</td>
    </tr>`,
    )
    .join('')}
  </tbody>
</table>`
}

<h2>Recent events <a href="/mod/events" style="font-size: 12px; font-weight: 400; margin-left: 0.5rem;">see all →</a></h2>
${
  recentEvents.length === 0
    ? '<p class="muted">No moderation events yet.</p>'
    : `<table>
  <thead><tr><th>When</th><th>Type</th><th>Subject</th><th>By</th></tr></thead>
  <tbody>
  ${recentEvents
    .map(
      (e) => `
    <tr>
      <td class="mono">${escape(formatRelativeTime(e.createdAt))}</td>
      <td class="mono">${eventPill(e.eventType)}</td>
      <td class="mono">${eventSubjectLink(e)}</td>
      <td class="mono">${escape(e.createdByDid)}</td>
    </tr>`,
    )
    .join('')}
  </tbody>
</table>`
}
`
        return renderModPage({
          title: 'Dashboard',
          body,
          currentPath: '/mod',
          signedInAs: { handle: session.handle, role: session.role },
        })
      },
    },
  },
})

async function loadCounts(): Promise<{
  openReports: number
  totalReports: number
  activeTakedowns: number
  totalEvents: number
  totalLabels: number
  leadHandle: string | null
  teamSize: number
}> {
  // Five small COUNT queries fanned out in parallel. The reports / events
  // tables are small in the steady state; we don't index for these
  // dashboard counts on purpose.
  const lead = await getModTeamLead()
  const [
    totalReportsRow,
    activeTakedownsRow,
    totalEventsRow,
    totalLabelsRow,
    teamSizeRow,
  ] = await Promise.all([
    db.select({ n: count() }).from(moderationReports),
    db
      .select({ n: count() })
      .from(modSubjectStatus)
      .where(isNotNull(modSubjectStatus.takedownEventId)),
    db.select({ n: count() }).from(modEvents),
    db.select({ n: count() }).from(sql`labels`),
    db.select({ n: count() }).from(sql`mod_team`),
  ])

  // "Open reports" is the exact count: every moderation_reports row
  // that doesn't yet have a mod_report_resolution link. The lateral
  // join + IS NULL filter is the canonical pattern.
  const openRow = await db
    .select({ n: count() })
    .from(moderationReports)
    .leftJoin(
      modReportResolution,
      sql`${modReportResolution.reportId} = ${moderationReports.id}`,
    )
    .where(sql`${modReportResolution.reportId} IS NULL`)

  const totalReports = Number(totalReportsRow[0]?.n ?? 0)
  const openReports = Number(openRow[0]?.n ?? 0)

  return {
    openReports,
    totalReports,
    activeTakedowns: Number(activeTakedownsRow[0]?.n ?? 0),
    totalEvents: Number(totalEventsRow[0]?.n ?? 0),
    totalLabels: Number(totalLabelsRow[0]?.n ?? 0),
    leadHandle: lead?.handle ?? null,
    teamSize: Number(teamSizeRow[0]?.n ?? 0),
  }
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = `/mod/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`
  return new Response(null, { status: 303, headers: { location: target } })
}

function subjectLink(r: {
  subjectDid: string | null
  subjectUri: string | null
}): string {
  if (r.subjectUri) {
    return `<a href="/mod/subject?q=${encodeURIComponent(r.subjectUri)}">${escape(r.subjectUri)}</a>`
  }
  if (r.subjectDid) {
    return `<a href="/mod/subject?q=${encodeURIComponent(r.subjectDid)}">${escape(r.subjectDid)}</a>`
  }
  return ''
}

function eventSubjectLink(e: {
  subjectDid: string | null
  subjectUri: string | null
}): string {
  return subjectLink(e)
}

function eventPill(eventType: string): string {
  const cls = eventType === 'modEventTakedown'
    ? 'pill-err'
    : eventType === 'modEventReverseTakedown'
      ? 'pill-ok'
      : eventType === 'modEventLabel'
        ? 'pill-warn'
        : ''
  return `<span class="pill ${cls}">${escape(eventType)}</span>`
}

function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
  if (diffMs < 30 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d ago`
  return d.toISOString().slice(0, 10)
}
