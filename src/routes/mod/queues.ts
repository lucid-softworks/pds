// GET  /mod/queues — list of moderation queues with stats + create form
// POST /mod/queues — apply an action: `create` / `toggle` / `delete` /
//                    `assign` / `unassign`. Mirrors the wire surface
//                    in tools.ozone.queue.* so the HTML and the XRPC
//                    can't drift.

import { createFileRoute } from '@tanstack/react-router'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { db } from '~/lib/db'
import {
  modQueueAssignments,
  modQueues,
  moderationReports,
} from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import { renderModPage, renderModNotProvisioned, escape } from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'
import { computeQueueStats } from '~/pds/mod/queue'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

export const Route = createFileRoute('/mod/queues')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Queues',
          currentPath: '/mod/queues',
          signedInAs: { handle: session.handle, role: session.role },
          body: await renderBody(session, csrf, null),
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

        const action = String(form.get('action') ?? '')
        let flash: { kind: 'ok' | 'error'; message: string } | null = null
        const createdBy = session.role === 'admin' ? 'admin' : session.did

        try {
          if (action === 'create') {
            const name = String(form.get('name') ?? '').trim()
            const description = String(form.get('description') ?? '').trim()
            const subjectTypes = String(form.get('subjectTypes') ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const reportTypes = String(form.get('reportTypes') ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const collection = String(form.get('collection') ?? '').trim()
            if (!name) throw new Error('name required')
            if (subjectTypes.length === 0) throw new Error('subjectTypes required (comma-separated)')
            if (reportTypes.length === 0) throw new Error('reportTypes required (comma-separated)')
            if (subjectTypes.includes('record') && !collection) {
              throw new Error("collection required when subjectTypes includes 'record'")
            }
            await db.insert(modQueues).values({
              name,
              description: description || null,
              subjectTypes,
              reportTypes,
              collection: collection || null,
              enabled: true,
              createdBy,
            })
            flash = { kind: 'ok', message: `created queue "${name}"` }
          } else if (action === 'toggle') {
            const queueId = Number.parseInt(String(form.get('queueId') ?? ''), 10)
            const enabled = form.get('enabled') === 'true'
            if (!Number.isFinite(queueId)) throw new Error('queueId required')
            await db
              .update(modQueues)
              .set({ enabled, updatedAt: new Date() })
              .where(eq(modQueues.id, queueId))
            flash = { kind: 'ok', message: `queue ${enabled ? 'enabled' : 'disabled'}` }
          } else if (action === 'delete') {
            const queueId = Number.parseInt(String(form.get('queueId') ?? ''), 10)
            if (!Number.isFinite(queueId)) throw new Error('queueId required')
            // soft-delete + drop the queue_id from any routed reports
            await pg
              .update(moderationReports)
              .set({ queueId: null })
              .where(eq(moderationReports.queueId, queueId))
            await db
              .update(modQueues)
              .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
              .where(eq(modQueues.id, queueId))
            flash = { kind: 'ok', message: 'queue deleted' }
          } else if (action === 'assign') {
            const queueId = Number.parseInt(String(form.get('queueId') ?? ''), 10)
            const did = String(form.get('did') ?? '').trim()
            if (!Number.isFinite(queueId)) throw new Error('queueId required')
            if (!did) throw new Error('did required')
            // close prior open assignment for the same (queue, did)
            await db
              .update(modQueueAssignments)
              .set({ endAt: new Date() })
              .where(
                and(
                  eq(modQueueAssignments.queueId, queueId),
                  eq(modQueueAssignments.did, did),
                  isNull(modQueueAssignments.endAt),
                ),
              )
            await db
              .insert(modQueueAssignments)
              .values({ queueId, did })
            flash = { kind: 'ok', message: `assigned ${did}` }
          } else if (action === 'unassign') {
            const queueId = Number.parseInt(String(form.get('queueId') ?? ''), 10)
            const did = String(form.get('did') ?? '').trim()
            if (!Number.isFinite(queueId)) throw new Error('queueId required')
            if (!did) throw new Error('did required')
            await db
              .update(modQueueAssignments)
              .set({ endAt: new Date() })
              .where(
                and(
                  eq(modQueueAssignments.queueId, queueId),
                  eq(modQueueAssignments.did, did),
                  isNull(modQueueAssignments.endAt),
                ),
              )
            flash = { kind: 'ok', message: `unassigned ${did}` }
          } else {
            throw new Error(`unknown action: ${action}`)
          }
        } catch (err) {
          flash = { kind: 'error', message: (err as Error).message }
        }

        const { token: csrfNew, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Queues',
          currentPath: '/mod/queues',
          signedInAs: { handle: session.handle, role: session.role },
          flash,
          body: await renderBody(session, csrfNew, flash),
        })
        if (csrfCookie) res.headers.set('set-cookie', csrfCookie)
        return res
      },
    },
  },
})

async function renderBody(
  session: { role: 'lead' | 'moderator' | 'admin' },
  csrf: string,
  flash: { kind: 'ok' | 'error'; message: string } | null,
): Promise<string> {
  void flash
  const queues = await db
    .select()
    .from(modQueues)
    .where(isNull(modQueues.deletedAt))
    .orderBy(asc(modQueues.id))

  const assignments = await db
    .select()
    .from(modQueueAssignments)
    .where(isNull(modQueueAssignments.endAt))

  const assignmentsByQueue = new Map<number, string[]>()
  for (const a of assignments) {
    const list = assignmentsByQueue.get(a.queueId) ?? []
    list.push(a.did)
    assignmentsByQueue.set(a.queueId, list)
  }

  const stats = await Promise.all(queues.map((q) => computeQueueStats(q.id)))

  const canMutate = session.role === 'lead' || session.role === 'admin'

  return `
<header>
  <p class="kicker">Moderation</p>
  <h1>Queues</h1>
  <p class="muted">Operator-defined buckets of (subject-type, report-type) routing rules. <code>tools.ozone.queue.routeReports</code> auto-routes new reports to whichever enabled queue matches.</p>
</header>

${queues.length === 0
  ? '<p class="muted">No queues configured yet.</p>'
  : `<table>
<thead><tr><th>Name</th><th>Subjects</th><th>Report types</th><th>Pending</th><th>Actioned</th><th>Inbound 24h</th><th>Enabled</th><th>Moderators</th>${canMutate ? '<th></th>' : ''}</tr></thead>
<tbody>${queues
    .map((q, i) => {
      const s = stats[i]!
      const mods = assignmentsByQueue.get(q.id) ?? []
      return `<tr>
  <td><strong>${escape(q.name)}</strong>${q.description ? `<br><span class="muted" style="font-size: 11px;">${escape(q.description)}</span>` : ''}</td>
  <td class="mono">${escape(q.subjectTypes.join(', '))}${q.collection ? `<br><span class="muted">${escape(q.collection)}</span>` : ''}</td>
  <td class="mono" style="font-size: 11px;">${escape(q.reportTypes.join(', '))}</td>
  <td>${s.pendingCount ?? 0}</td>
  <td>${s.actionedCount ?? 0}</td>
  <td>${s.inboundCount ?? 0}</td>
  <td>${q.enabled ? '<span class="pill pill-ok">on</span>' : '<span class="pill">off</span>'}</td>
  <td class="mono" style="font-size: 11px;">${mods.length === 0 ? '<span class="muted">none</span>' : mods.map((d) => escape(d)).join('<br>')}</td>
  ${canMutate
    ? `<td>
         <form method="POST" action="/mod/queues" class="inline-form">
           <input type="hidden" name="csrf" value="${escape(csrf)}">
           <input type="hidden" name="action" value="toggle">
           <input type="hidden" name="queueId" value="${q.id}">
           <input type="hidden" name="enabled" value="${q.enabled ? 'false' : 'true'}">
           <button type="submit" style="padding: 0.2rem 0.6rem; font-size: 11px;">${q.enabled ? 'Disable' : 'Enable'}</button>
         </form>
         <form method="POST" action="/mod/queues" class="inline-form" onsubmit="return confirm('Delete queue ${escape(q.name)}?');" style="margin-top: 0.25rem;">
           <input type="hidden" name="csrf" value="${escape(csrf)}">
           <input type="hidden" name="action" value="delete">
           <input type="hidden" name="queueId" value="${q.id}">
           <button type="submit" class="danger" style="padding: 0.2rem 0.6rem; font-size: 11px;">Delete</button>
         </form>
       </td>`
    : ''}
</tr>`
    })
    .join('')}</tbody>
</table>`}

${canMutate
  ? `<h2>Create a queue</h2>
<form method="POST" action="/mod/queues" class="form">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <input type="hidden" name="action" value="create">
  <label>
    <span>Name</span>
    <input type="text" name="name" required>
  </label>
  <label>
    <span>Description</span>
    <input type="text" name="description">
  </label>
  <label>
    <span>Subject types (comma-separated)</span>
    <input type="text" name="subjectTypes" placeholder="account, record" required>
  </label>
  <label>
    <span>Collection (if subjectTypes includes <code>record</code>)</span>
    <input type="text" name="collection" placeholder="app.bsky.feed.post">
  </label>
  <label>
    <span>Report types — NSIDs, comma-separated</span>
    <input type="text" name="reportTypes" placeholder="com.atproto.moderation.defs#reasonSpam" required>
  </label>
  <button type="submit" class="primary">Create queue</button>
</form>

<h2>Assign / unassign a moderator</h2>
<form method="POST" action="/mod/queues" class="form">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <input type="hidden" name="action" value="assign">
  <label>
    <span>Queue ID</span>
    <input type="number" name="queueId" required>
  </label>
  <label>
    <span>Moderator DID</span>
    <input type="text" name="did" placeholder="did:plc:..." required>
  </label>
  <button type="submit" class="primary">Assign</button>
</form>
<p class="muted" style="font-size: 12px;">Use the <code>unassign</code> action by changing the form's hidden <code>action</code> field, or unassign inline from the row's Moderators column (TODO).</p>`
  : '<p class="muted">Only the team lead (or an admin) can change queue configuration.</p>'}
`
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
