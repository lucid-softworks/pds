// GET  /mod/safelink — current rule table + add form + recent events.
// POST /mod/safelink — add / update / remove a rule. Thin wrapper over
//                     the tools.ozone.safelink.* XRPC; calls the same
//                     internal helpers so the UI and API share the
//                     audit log.

import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { safelinkEvents, safelinkRules } from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'

export const Route = createFileRoute('/mod/safelink')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const [rules, events] = await Promise.all([
          db
            .select()
            .from(safelinkRules)
            .orderBy(desc(safelinkRules.updatedAt))
            .limit(200),
          db
            .select()
            .from(safelinkEvents)
            .orderBy(desc(safelinkEvents.id))
            .limit(50),
        ])

        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Safelink',
          currentPath: '/mod/safelink',
          signedInAs: { handle: session.handle, role: session.role },
          body: renderBody({ rules, events, csrf }),
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
        const url = String(form.get('url') ?? '').trim()
        const pattern = String(form.get('pattern') ?? '').trim()
        if (!url || (pattern !== 'domain' && pattern !== 'url')) {
          return badRequest('url + pattern (domain|url) required')
        }
        const actor = session.role === 'admin' ? null : session.did

        if (action === 'add' || action === 'update') {
          const ruleAction = String(form.get('ruleAction') ?? '').trim()
          if (!['block', 'warn', 'whitelist'].includes(ruleAction)) {
            return badRequest('action must be block|warn|whitelist')
          }
          const reason = String(form.get('reason') ?? '').trim() || 'none'
          const comment = String(form.get('comment') ?? '').trim() || null

          const existing = (
            await db
              .select()
              .from(safelinkRules)
              .where(
                and(
                  eq(safelinkRules.url, url),
                  eq(safelinkRules.pattern, pattern),
                ),
              )
              .limit(1)
          )[0]
          if (existing) {
            await db
              .update(safelinkRules)
              .set({
                action: ruleAction,
                reason,
                comment,
                updatedAt: sql`now()`,
                lastUpdatedBy: actor,
              })
              .where(
                and(
                  eq(safelinkRules.url, url),
                  eq(safelinkRules.pattern, pattern),
                ),
              )
          } else {
            await db.insert(safelinkRules).values({
              url,
              pattern,
              action: ruleAction,
              reason,
              comment,
              lastUpdatedBy: actor,
            })
          }
          await db.insert(safelinkEvents).values({
            eventType: existing ? 'updateRule' : 'addRule',
            url,
            pattern,
            action: ruleAction,
            reason,
            comment,
            createdBy: actor,
          })
        } else if (action === 'remove') {
          const existing = (
            await db
              .select()
              .from(safelinkRules)
              .where(
                and(
                  eq(safelinkRules.url, url),
                  eq(safelinkRules.pattern, pattern),
                ),
              )
              .limit(1)
          )[0]
          if (!existing) return badRequest('rule not found')
          await db
            .delete(safelinkRules)
            .where(
              and(
                eq(safelinkRules.url, url),
                eq(safelinkRules.pattern, pattern),
              ),
            )
          await db.insert(safelinkEvents).values({
            eventType: 'removeRule',
            url,
            pattern,
            action: existing.action,
            reason: existing.reason,
            comment: existing.comment,
            createdBy: actor,
          })
        } else {
          return badRequest(`unknown action: ${action}`)
        }

        return new Response(null, {
          status: 303,
          headers: { location: '/mod/safelink' },
        })
      },
    },
  },
})

function renderBody(args: {
  rules: Array<typeof safelinkRules.$inferSelect>
  events: Array<typeof safelinkEvents.$inferSelect>
  csrf: string
}): string {
  return `
<header>
  <p class="kicker">URL safety</p>
  <h1>Safelink</h1>
  <p class="muted">
    Block / warn / whitelist rules consumed by AppViews via
    <code>tools.ozone.safelink.queryRules</code>. Each change appends a
    row to the audit log; the upstream Ozone client speaks the same XRPC
    shape.
  </p>
</header>

<h2>Active rules (${args.rules.length})</h2>
${args.rules.length === 0
  ? '<p class="muted">No rules yet.</p>'
  : `<table>
<thead><tr><th>URL / domain</th><th>Pattern</th><th>Action</th><th>Reason</th><th>Updated</th><th></th></tr></thead>
<tbody>${args.rules.map((r) => `<tr>
  <td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;">${escape(r.url)}</td>
  <td class="mono">${escape(r.pattern)}</td>
  <td>${ruleActionPill(r.action)}</td>
  <td class="mono">${escape(r.reason)}</td>
  <td class="mono">${escape(formatRelativeTime(r.updatedAt))}</td>
  <td>
    <form method="POST" action="/mod/safelink" class="inline-form" onsubmit="return confirm('Remove ${escape(r.pattern)}/${escape(r.url)}?');">
      <input type="hidden" name="csrf" value="${escape(args.csrf)}">
      <input type="hidden" name="action" value="remove">
      <input type="hidden" name="url" value="${escape(r.url)}">
      <input type="hidden" name="pattern" value="${escape(r.pattern)}">
      <button type="submit" class="danger" style="padding:0.2rem 0.6rem;font-size:11px;">Remove</button>
    </form>
  </td>
</tr>`).join('')}</tbody>
</table>`}

<h2>Add / update rule</h2>
<form method="POST" action="/mod/safelink" class="form" style="max-width:520px;">
  <input type="hidden" name="csrf" value="${escape(args.csrf)}">
  <input type="hidden" name="action" value="add">
  <label>
    <span>URL or domain</span>
    <input type="text" name="url" placeholder="example.com or https://example.com/path" required>
  </label>
  <label>
    <span>Pattern</span>
    <select name="pattern">
      <option value="domain" selected>domain</option>
      <option value="url">url</option>
    </select>
  </label>
  <label>
    <span>Action</span>
    <select name="ruleAction">
      <option value="block">block</option>
      <option value="warn" selected>warn</option>
      <option value="whitelist">whitelist</option>
    </select>
  </label>
  <label>
    <span>Reason</span>
    <input type="text" name="reason" placeholder="csam | spam | phishing | none" value="none">
  </label>
  <label>
    <span>Comment (optional)</span>
    <textarea name="comment" rows="2"></textarea>
  </label>
  <button type="submit" class="primary">Save rule</button>
</form>

<h2>Recent audit events (${args.events.length})</h2>
${args.events.length === 0
  ? '<p class="muted">No events yet.</p>'
  : `<table>
<thead><tr><th>When</th><th>Type</th><th>URL / domain</th><th>Pattern</th><th>Action</th><th>Reason</th><th>By</th></tr></thead>
<tbody>${args.events.map((e) => `<tr>
  <td class="mono">${escape(formatRelativeTime(e.createdAt))}</td>
  <td class="mono">${escape(e.eventType)}</td>
  <td class="mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;">${escape(e.url)}</td>
  <td class="mono">${escape(e.pattern)}</td>
  <td>${e.action ? ruleActionPill(e.action) : ''}</td>
  <td class="mono">${escape(e.reason ?? '')}</td>
  <td class="mono">${escape(e.createdBy ?? 'admin')}</td>
</tr>`).join('')}</tbody>
</table>`}
`
}

function ruleActionPill(action: string): string {
  const cls =
    action === 'block'
      ? 'pill-err'
      : action === 'warn'
        ? 'pill-warn'
        : 'pill-ok'
  return `<span class="pill ${cls}">${escape(action)}</span>`
}

function mintOrReuseCsrf(
  request: Request,
): { token: string; setCookieHeader: string } {
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
