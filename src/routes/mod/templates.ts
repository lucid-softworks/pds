// GET  /mod/templates — list communication templates.
// POST /mod/templates — create / update / delete a template. Backs
//                       modEventEmail when an operator picks the
//                       template by name.

import { createFileRoute } from '@tanstack/react-router'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { ozoneCommTemplates } from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'

export const Route = createFileRoute('/mod/templates')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)
        const rows = await db
          .select()
          .from(ozoneCommTemplates)
          .orderBy(asc(ozoneCommTemplates.name))
        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Templates',
          currentPath: '/mod/templates',
          signedInAs: { handle: session.handle, role: session.role },
          body: renderBody({ rows, csrf }),
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
        const actor = session.role === 'admin' ? null : session.did

        if (action === 'create') {
          const name = String(form.get('name') ?? '').trim()
          const subject = String(form.get('subject') ?? '').trim()
          const contentMarkdown = String(form.get('contentMarkdown') ?? '').trim()
          const lang = String(form.get('lang') ?? '').trim() || null
          if (!name || !subject || !contentMarkdown) {
            return badRequest('name + subject + contentMarkdown required')
          }
          try {
            await db.insert(ozoneCommTemplates).values({
              name,
              subject,
              contentMarkdown,
              lang,
              lastUpdatedBy: actor,
            })
          } catch (err) {
            if ((err as { code?: string } | null)?.code === '23505') {
              return badRequest(`template name already exists: ${name}`)
            }
            throw err
          }
        } else if (action === 'update') {
          const id = Number.parseInt(String(form.get('id') ?? ''), 10)
          if (!Number.isFinite(id)) return badRequest('invalid id')
          const patch: Record<string, unknown> = {
            updatedAt: sql`now()`,
            lastUpdatedBy: actor,
          }
          const name = String(form.get('name') ?? '').trim()
          const subject = String(form.get('subject') ?? '').trim()
          const contentMarkdown = String(form.get('contentMarkdown') ?? '').trim()
          const lang = String(form.get('lang') ?? '').trim()
          if (name) patch.name = name
          if (subject) patch.subject = subject
          if (contentMarkdown) patch.contentMarkdown = contentMarkdown
          if (lang) patch.lang = lang
          patch.disabled = form.get('disabled') === 'on'
          await db
            .update(ozoneCommTemplates)
            .set(patch)
            .where(eq(ozoneCommTemplates.id, id))
        } else if (action === 'delete') {
          const id = Number.parseInt(String(form.get('id') ?? ''), 10)
          if (!Number.isFinite(id)) return badRequest('invalid id')
          await db
            .delete(ozoneCommTemplates)
            .where(eq(ozoneCommTemplates.id, id))
        } else {
          return badRequest(`unknown action: ${action}`)
        }
        return new Response(null, {
          status: 303,
          headers: { location: '/mod/templates' },
        })
      },
    },
  },
})

function renderBody(args: {
  rows: Array<typeof ozoneCommTemplates.$inferSelect>
  csrf: string
}): string {
  return `
<header>
  <p class="kicker">Communication</p>
  <h1>Templates</h1>
  <p class="muted">
    Canned operator-to-user email templates. The
    <code>modEventEmail</code> handler pulls a template by name when
    its <code>templateName</code> field is set and uses
    <code>content_markdown</code> as the body.
  </p>
</header>

${args.rows.length === 0
  ? '<p class="muted">No templates yet. Add one below.</p>'
  : args.rows.map((r) => `
<details style="margin-bottom:1rem;border:1px solid var(--border);border-radius:6px;padding:0.75rem 1rem;background:var(--surface);">
  <summary style="cursor:pointer;font-family:ui-monospace,monospace;font-size:13px;">
    <strong>${escape(r.name)}</strong>
    <span class="muted" style="margin-left:0.5rem;">— ${escape(r.subject)}</span>
    ${r.disabled ? '<span class="pill pill-warn" style="margin-left:0.5rem;">disabled</span>' : ''}
  </summary>
  <form method="POST" action="/mod/templates" class="form" style="max-width:640px;margin-top:0.75rem;">
    <input type="hidden" name="csrf" value="${escape(args.csrf)}">
    <input type="hidden" name="action" value="update">
    <input type="hidden" name="id" value="${r.id}">
    <label><span>Name</span><input type="text" name="name" value="${escape(r.name)}" required></label>
    <label><span>Subject</span><input type="text" name="subject" value="${escape(r.subject)}" required></label>
    <label><span>Content (Markdown)</span><textarea name="contentMarkdown" rows="6" required>${escape(r.contentMarkdown)}</textarea></label>
    <label><span>Locale (optional)</span><input type="text" name="lang" value="${escape(r.lang ?? '')}" maxlength="8"></label>
    <label style="grid-template-columns:auto 1fr;align-items:center;">
      <input type="checkbox" name="disabled" style="width:auto;" ${r.disabled ? 'checked' : ''}>
      <span style="text-transform:none;letter-spacing:0;">Disabled</span>
    </label>
    <div class="action-row">
      <button type="submit" class="primary">Save</button>
    </div>
  </form>
  <form method="POST" action="/mod/templates" class="inline-form" style="margin-top:0.5rem;" onsubmit="return confirm('Delete template ${escape(r.name)}?');">
    <input type="hidden" name="csrf" value="${escape(args.csrf)}">
    <input type="hidden" name="action" value="delete">
    <input type="hidden" name="id" value="${r.id}">
    <button type="submit" class="danger" style="padding:0.3rem 0.7rem;font-size:12px;">Delete</button>
  </form>
</details>
`).join('')}

<h2>Add a template</h2>
<form method="POST" action="/mod/templates" class="form" style="max-width:640px;">
  <input type="hidden" name="csrf" value="${escape(args.csrf)}">
  <input type="hidden" name="action" value="create">
  <label><span>Name</span><input type="text" name="name" placeholder="warn-spam-account" required></label>
  <label><span>Subject</span><input type="text" name="subject" placeholder="A warning from the moderation team" required></label>
  <label><span>Content (Markdown)</span><textarea name="contentMarkdown" rows="8" placeholder="Hi, we noticed..." required></textarea></label>
  <label><span>Locale (optional)</span><input type="text" name="lang" value="en" maxlength="8"></label>
  <button type="submit" class="primary">Create</button>
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
