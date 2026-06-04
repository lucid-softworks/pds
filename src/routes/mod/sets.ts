// GET  /mod/sets[?name=…]
//        - no name: list every set + size
//        - with name: drill into the set, show its values + add/remove
// POST /mod/sets — create / delete a set, add / remove values.

import { createFileRoute } from '@tanstack/react-router'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { ozoneSetValues, ozoneSets } from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'

export const Route = createFileRoute('/mod/sets')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)
        const url = new URL(request.url)
        const focusName = url.searchParams.get('name')?.trim() ?? null

        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const body = focusName
          ? await renderSetView(focusName, csrf)
          : await renderSetList(csrf)
        const res = renderModPage({
          title: focusName ? `Set: ${focusName}` : 'Sets',
          currentPath: '/mod/sets',
          signedInAs: { handle: session.handle, role: session.role },
          body,
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

        if (action === 'createSet') {
          const name = String(form.get('name') ?? '').trim()
          if (!/^[A-Za-z0-9_\-.]{3,128}$/.test(name)) {
            return badRequest('name must be 3..128 chars of [A-Za-z0-9_-.]')
          }
          const description =
            String(form.get('description') ?? '').trim() || null
          await db
            .insert(ozoneSets)
            .values({ name, description })
            .onConflictDoNothing({ target: ozoneSets.name })
          return redirect(`/mod/sets?name=${encodeURIComponent(name)}`)
        }

        if (action === 'deleteSet') {
          const name = String(form.get('name') ?? '').trim()
          if (!name) return badRequest('name required')
          // FK cascade on ozone_set_values takes members with it.
          await db.delete(ozoneSets).where(eq(ozoneSets.name, name))
          return redirect('/mod/sets')
        }

        if (action === 'addValues' || action === 'deleteValues') {
          const name = String(form.get('name') ?? '').trim()
          if (!name) return badRequest('name required')
          const raw = String(form.get('values') ?? '')
          const values = Array.from(
            new Set(
              raw
                .split(/[,\n]/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            ),
          )
          if (values.length === 0) return badRequest('values required')
          if (action === 'addValues') {
            await db
              .insert(ozoneSetValues)
              .values(values.map((value) => ({ setName: name, value })))
              .onConflictDoNothing()
          } else {
            await db
              .delete(ozoneSetValues)
              .where(
                and(
                  eq(ozoneSetValues.setName, name),
                  sql`${ozoneSetValues.value} = ANY(${values})`,
                ),
              )
          }
          return redirect(`/mod/sets?name=${encodeURIComponent(name)}`)
        }

        return badRequest(`unknown action: ${action}`)
      },
    },
  },
})

async function renderSetList(csrf: string): Promise<string> {
  const rows = await db
    .select({
      name: ozoneSets.name,
      description: ozoneSets.description,
      createdAt: ozoneSets.createdAt,
      size: sql<number>`(
        select count(*) from ${ozoneSetValues}
        where ${ozoneSetValues.setName} = ${ozoneSets.name}
      )::int`,
    })
    .from(ozoneSets)
    .orderBy(asc(ozoneSets.name))
  return `
<header>
  <p class="kicker">Subject sets</p>
  <h1>Sets</h1>
  <p class="muted">
    Named string groups consumed by <code>tools.ozone.set.*</code>. The
    semantics of each value are operator-defined — DIDs, URIs, domains,
    whatever the policies in use need to group.
  </p>
</header>

${rows.length === 0
  ? '<p class="muted">No sets yet.</p>'
  : `<table>
<thead><tr><th>Name</th><th>Size</th><th>Description</th><th>Created</th><th></th></tr></thead>
<tbody>${rows.map((r) => `<tr>
  <td class="mono"><a href="/mod/sets?name=${encodeURIComponent(r.name)}">${escape(r.name)}</a></td>
  <td class="num">${Number(r.size)}</td>
  <td>${escape(r.description ?? '')}</td>
  <td class="mono">${escape(formatRelativeTime(r.createdAt))}</td>
  <td>
    <form method="POST" action="/mod/sets" class="inline-form" onsubmit="return confirm('Delete set ${escape(r.name)} and all its values?');">
      <input type="hidden" name="csrf" value="${escape(csrf)}">
      <input type="hidden" name="action" value="deleteSet">
      <input type="hidden" name="name" value="${escape(r.name)}">
      <button type="submit" class="danger" style="padding:0.2rem 0.6rem;font-size:11px;">Delete</button>
    </form>
  </td>
</tr>`).join('')}</tbody>
</table>`}

<h2>Create a set</h2>
<form method="POST" action="/mod/sets" class="form" style="max-width:520px;">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <input type="hidden" name="action" value="createSet">
  <label><span>Name</span><input type="text" name="name" required pattern="[A-Za-z0-9_\\-.]{3,128}"></label>
  <label><span>Description (optional)</span><textarea name="description" rows="2"></textarea></label>
  <button type="submit" class="primary">Create</button>
</form>
`
}

async function renderSetView(name: string, csrf: string): Promise<string> {
  const setRow = (
    await db
      .select()
      .from(ozoneSets)
      .where(eq(ozoneSets.name, name))
      .limit(1)
  )[0]
  if (!setRow) {
    return `<p class="muted">Set <code>${escape(name)}</code> not found. <a href="/mod/sets">← back</a></p>`
  }
  const values = await db
    .select({ value: ozoneSetValues.value, addedAt: ozoneSetValues.addedAt })
    .from(ozoneSetValues)
    .where(eq(ozoneSetValues.setName, name))
    .orderBy(asc(ozoneSetValues.value))
    .limit(500)
  return `
<p style="font-size:12px;"><a href="/mod/sets">← all sets</a></p>
<header>
  <p class="kicker">Subject set</p>
  <h1><code>${escape(name)}</code></h1>
  ${setRow.description ? `<p class="muted">${escape(setRow.description)}</p>` : ''}
  <p class="muted">${values.length} value${values.length === 1 ? '' : 's'}</p>
</header>

<h2>Values</h2>
${values.length === 0
  ? '<p class="muted">No values yet. Add some below.</p>'
  : `<table>
<thead><tr><th>Value</th><th>Added</th><th></th></tr></thead>
<tbody>${values.map((v) => `<tr>
  <td class="mono">${escape(v.value)}</td>
  <td class="mono">${escape(formatRelativeTime(v.addedAt))}</td>
  <td>
    <form method="POST" action="/mod/sets" class="inline-form">
      <input type="hidden" name="csrf" value="${escape(csrf)}">
      <input type="hidden" name="action" value="deleteValues">
      <input type="hidden" name="name" value="${escape(name)}">
      <input type="hidden" name="values" value="${escape(v.value)}">
      <button type="submit" class="danger" style="padding:0.2rem 0.6rem;font-size:11px;">Remove</button>
    </form>
  </td>
</tr>`).join('')}</tbody>
</table>`}

<h2>Add values</h2>
<form method="POST" action="/mod/sets" class="form" style="max-width:640px;">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <input type="hidden" name="action" value="addValues">
  <input type="hidden" name="name" value="${escape(name)}">
  <label><span>Values (comma- or newline-separated)</span>
  <textarea name="values" rows="5" placeholder="did:plc:...&#10;example.com&#10;..."></textarea></label>
  <button type="submit" class="primary">Add</button>
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

function redirect(target: string): Response {
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
