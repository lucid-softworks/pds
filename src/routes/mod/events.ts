// GET /mod/events — paginated moderation-event history.
//
// Query knobs:
//   ?types=modEventTakedown,modEventLabel,...   (comma-separated, no #)
//   ?createdBy=did:plc:...                       (filter by moderator)
//   ?subject=did:plc:...  OR  ?subject=at://...  (filter by subject)
//   ?cursor=<id>                                  (last id from prev page)
//
// Renders the same shape as the dashboard preview but uncapped.

import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { modEvents } from '~/lib/db/schema'
import { readModSession } from '~/lib/mod-ui/auth'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'

const PAGE_LIMIT = 100

export const Route = createFileRoute('/mod/events')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const url = new URL(request.url)
        const cursorRaw = url.searchParams.get('cursor')
        const cursorId = cursorRaw ? Number.parseInt(cursorRaw, 10) : undefined
        const types = parseCommaParam(url.searchParams.get('types')).map(
          stripPrefix,
        )
        const createdBy = url.searchParams.get('createdBy')?.trim() ?? ''
        const subject = url.searchParams.get('subject')?.trim() ?? ''

        const subjectClause = subject
          ? subject.startsWith('at://')
            ? eq(modEvents.subjectUri, subject)
            : /^did:/.test(subject)
              ? or(
                  eq(modEvents.subjectDid, subject),
                  sql`${modEvents.subjectUri} LIKE ${`at://${subject}/%`}`,
                )
              : undefined
          : undefined

        const where = and(
          types.length > 0 ? inArray(modEvents.eventType, types) : undefined,
          createdBy ? eq(modEvents.createdByDid, createdBy) : undefined,
          subjectClause,
          cursorId !== undefined ? lt(modEvents.id, cursorId) : undefined,
        )

        const rows = await db
          .select()
          .from(modEvents)
          .where(where)
          .orderBy(desc(modEvents.id))
          .limit(PAGE_LIMIT + 1)

        const page = rows.slice(0, PAGE_LIMIT)
        const nextCursor =
          rows.length > PAGE_LIMIT && page.length > 0
            ? page[page.length - 1]!.id
            : null

        const filterPills = `
<div class="muted" style="font-size: 12px; display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;">
  ${types.length > 0 ? `<span class="pill">types: ${escape(types.join(', '))}</span>` : ''}
  ${createdBy ? `<span class="pill">createdBy: ${escape(createdBy)}</span>` : ''}
  ${subject ? `<span class="pill">subject: ${escape(subject)}</span>` : ''}
  ${types.length || createdBy || subject ? '<a href="/mod/events">clear filters</a>' : ''}
</div>`

        const table =
          page.length === 0
            ? '<p class="muted">No events match.</p>'
            : `<table>
<thead><tr><th>When</th><th>Type</th><th>Subject</th><th>By</th><th>Comment</th></tr></thead>
<tbody>${page
  .map(
    (e) => `<tr>
  <td class="mono">${escape(formatRelativeTime(e.createdAt))}</td>
  <td class="mono"><span class="pill ${eventTypePill(e.eventType)}">${escape(e.eventType)}</span></td>
  <td class="mono">${
    e.subjectUri
      ? `<a href="/mod/subject?q=${encodeURIComponent(e.subjectUri)}">${escape(e.subjectUri)}</a>`
      : e.subjectDid
        ? `<a href="/mod/subject?q=${encodeURIComponent(e.subjectDid)}">${escape(e.subjectDid)}</a>`
        : ''
  }</td>
  <td class="mono">${escape(e.createdByDid)}</td>
  <td>${escape(e.comment ?? '')}</td>
</tr>`,
  )
  .join('')}</tbody>
</table>`

        const pager =
          nextCursor !== null
            ? `<p style="margin-top: 1.5rem;"><a href="/mod/events?${preserveQuery(url, { cursor: String(nextCursor) })}">Next page →</a></p>`
            : ''

        return renderModPage({
          title: 'Events',
          currentPath: '/mod/events',
          signedInAs: { handle: session.handle, role: session.role },
          body: `
<header>
  <p class="kicker">History</p>
  <h1>Events</h1>
  <p class="muted">${page.length} events on this page · most recent first</p>
</header>
${filterPills}
${table}
${pager}
`,
        })
      },
    },
  },
})

function parseCommaParam(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function stripPrefix(s: string): string {
  const idx = s.indexOf('#')
  return idx >= 0 ? s.slice(idx + 1) : s
}

function preserveQuery(
  url: URL,
  overrides: Record<string, string>,
): string {
  const sp = new URLSearchParams(url.searchParams)
  for (const [k, v] of Object.entries(overrides)) sp.set(k, v)
  return sp.toString()
}

function eventTypePill(t: string): string {
  if (t === 'modEventTakedown') return 'pill-err'
  if (t === 'modEventReverseTakedown') return 'pill-ok'
  if (t === 'modEventLabel') return 'pill-warn'
  return ''
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = `/mod/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`
  return new Response(null, { status: 303, headers: { location: target } })
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
