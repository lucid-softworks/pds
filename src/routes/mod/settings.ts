// GET  /mod/settings — instance-scope key/value editor.
// POST /mod/settings — upsert / remove a setting.
//
// Personal-scope settings (per-moderator) are storable via the XRPC
// but not surfaced here — the operator console only shows the
// instance-global pool to keep the UI legible.

import { createFileRoute } from '@tanstack/react-router'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { ozoneSettings } from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'
import { decode, encode } from '~/pds/codec'

export const Route = createFileRoute('/mod/settings')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)
        const rows = await db
          .select()
          .from(ozoneSettings)
          .where(
            and(
              eq(ozoneSettings.scope, 'instance'),
              isNull(ozoneSettings.managedByDid),
            ),
          )
          .orderBy(asc(ozoneSettings.key))
        const decoded = await Promise.all(
          rows.map(async (r) => ({ ...r, value: await decode(r.value) })),
        )
        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Settings',
          currentPath: '/mod/settings',
          signedInAs: { handle: session.handle, role: session.role },
          body: renderBody({ rows: decoded, csrf }),
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
        const key = String(form.get('key') ?? '').trim()
        if (!key) return badRequest('key required')
        const actor = session.role === 'admin' ? null : session.did

        if (action === 'upsert') {
          const rawJson = String(form.get('value') ?? '').trim()
          let parsedValue: unknown
          try {
            parsedValue = rawJson.length === 0 ? null : JSON.parse(rawJson)
          } catch {
            return badRequest('value must be valid JSON (or empty for null)')
          }
          const description =
            String(form.get('description') ?? '').trim() || null
          const valueBytes = (await encode(parsedValue)).bytes

          const existing = await db
            .select({ key: ozoneSettings.key })
            .from(ozoneSettings)
            .where(
              and(
                eq(ozoneSettings.key, key),
                eq(ozoneSettings.scope, 'instance'),
                isNull(ozoneSettings.managedByDid),
              ),
            )
            .limit(1)

          if (existing.length === 0) {
            await db.insert(ozoneSettings).values({
              key,
              scope: 'instance',
              managedByDid: null,
              value: valueBytes,
              description,
              lastUpdatedBy: actor,
            })
          } else {
            await db
              .update(ozoneSettings)
              .set({
                value: valueBytes,
                description,
                updatedAt: sql`now()`,
                lastUpdatedBy: actor,
              })
              .where(
                and(
                  eq(ozoneSettings.key, key),
                  eq(ozoneSettings.scope, 'instance'),
                  isNull(ozoneSettings.managedByDid),
                ),
              )
          }
        } else if (action === 'remove') {
          await db
            .delete(ozoneSettings)
            .where(
              and(
                eq(ozoneSettings.key, key),
                eq(ozoneSettings.scope, 'instance'),
                isNull(ozoneSettings.managedByDid),
              ),
            )
        } else {
          return badRequest(`unknown action: ${action}`)
        }
        return new Response(null, {
          status: 303,
          headers: { location: '/mod/settings' },
        })
      },
    },
  },
})

function renderBody(args: {
  rows: Array<{
    key: string
    value: unknown
    description: string | null
    updatedAt: Date
    lastUpdatedBy: string | null
  }>
  csrf: string
}): string {
  return `
<header>
  <p class="kicker">Operator config</p>
  <h1>Settings</h1>
  <p class="muted">
    Instance-scope key/value store backed by <code>ozone_settings</code>.
    Personal-scope (per-moderator) entries are storable via
    <code>tools.ozone.setting.upsertOption</code> but not displayed here.
  </p>
</header>

${args.rows.length === 0
  ? '<p class="muted">No settings yet.</p>'
  : args.rows.map((r) => `
<details style="margin-bottom:1rem;border:1px solid var(--border);border-radius:6px;padding:0.75rem 1rem;background:var(--surface);">
  <summary style="cursor:pointer;font-family:ui-monospace,monospace;font-size:13px;">
    <strong>${escape(r.key)}</strong>
    ${r.description ? `<span class="muted" style="margin-left:0.5rem;">— ${escape(r.description)}</span>` : ''}
    <span class="muted" style="margin-left:0.5rem;font-size:11px;">updated ${escape(formatRelativeTime(r.updatedAt))} by ${escape(r.lastUpdatedBy ?? 'admin')}</span>
  </summary>
  <form method="POST" action="/mod/settings" class="form" style="max-width:640px;margin-top:0.75rem;">
    <input type="hidden" name="csrf" value="${escape(args.csrf)}">
    <input type="hidden" name="action" value="upsert">
    <input type="hidden" name="key" value="${escape(r.key)}">
    <label><span>Value (JSON)</span><textarea name="value" rows="6">${escape(JSON.stringify(r.value, null, 2))}</textarea></label>
    <label><span>Description</span><input type="text" name="description" value="${escape(r.description ?? '')}"></label>
    <div class="action-row">
      <button type="submit" class="primary">Save</button>
    </div>
  </form>
  <form method="POST" action="/mod/settings" class="inline-form" style="margin-top:0.5rem;" onsubmit="return confirm('Delete setting ${escape(r.key)}?');">
    <input type="hidden" name="csrf" value="${escape(args.csrf)}">
    <input type="hidden" name="action" value="remove">
    <input type="hidden" name="key" value="${escape(r.key)}">
    <button type="submit" class="danger" style="padding:0.3rem 0.7rem;font-size:12px;">Delete</button>
  </form>
</details>
`).join('')}

<h2>Add a setting</h2>
<form method="POST" action="/mod/settings" class="form" style="max-width:640px;">
  <input type="hidden" name="csrf" value="${escape(args.csrf)}">
  <input type="hidden" name="action" value="upsert">
  <label><span>Key</span><input type="text" name="key" required></label>
  <label><span>Value (JSON, blank for null)</span><textarea name="value" rows="6" placeholder='"some string" or { "nested": true } or 42'></textarea></label>
  <label><span>Description (optional)</span><input type="text" name="description"></label>
  <button type="submit" class="primary">Save</button>
</form>
`
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
