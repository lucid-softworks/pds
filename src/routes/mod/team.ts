// GET  /mod/team — roster of the moderation team with add + remove
//                   forms (lead-only).
// POST /mod/team   — apply an action: `add` resolves a handle to a DID
//                   and inserts a moderator row; `remove` deletes a
//                   moderator row (never the lead).

import { createFileRoute } from '@tanstack/react-router'
import { asc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, modTeam } from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import {
  addModerator,
  getModTeamLead,
  removeModerator,
} from '~/pds/mod/team'
import { getConfig } from '~/lib/config'

export const Route = createFileRoute('/mod/team')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const { token: csrf, setCookieHeader: csrfCookie } = mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Team',
          currentPath: '/mod/team',
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

        // Lead-only mutation. Admin Basic also unlocks (the "admin can
        // do anything" invariant); moderators (non-lead) can't change
        // the roster.
        if (session.role !== 'lead' && session.role !== 'admin') {
          return forbidden('only the team lead (or admin) may change the roster')
        }

        const action = String(form.get('action') ?? '')
        let flash: { kind: 'ok' | 'error'; message: string } | null = null

        if (action === 'add') {
          const handle = String(form.get('handle') ?? '')
            .trim()
            .toLowerCase()
          if (!handle) {
            flash = { kind: 'error', message: 'handle required' }
          } else {
            const rows = await db
              .select({ did: accounts.did, status: accounts.status })
              .from(accounts)
              .where(eq(accounts.handle, handle))
              .limit(1)
            const acct = rows[0]
            if (!acct) {
              flash = {
                kind: 'error',
                message: `no account on this PDS with handle ${handle}`,
              }
            } else if (acct.status !== 'active') {
              flash = {
                kind: 'error',
                message: `account ${handle} is ${acct.status}; only active accounts can be moderators`,
              }
            } else {
              await addModerator({
                did: acct.did,
                role: 'moderator',
                addedBy: session.role === 'admin' ? null : session.did,
              })
              flash = { kind: 'ok', message: `added @${handle} to the team` }
            }
          }
        } else if (action === 'remove') {
          const did = String(form.get('did') ?? '').trim()
          if (!did) {
            flash = { kind: 'error', message: 'did required' }
          } else {
            const ok = await removeModerator(did)
            flash = ok
              ? { kind: 'ok', message: `removed ${did}` }
              : { kind: 'error', message: `cannot remove ${did} (lead seat, or not on the team)` }
          }
        } else {
          flash = { kind: 'error', message: `unknown action: ${action}` }
        }

        const { token: csrfNew, setCookieHeader: csrfCookie } = mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Team',
          currentPath: '/mod/team',
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
  session: { handle: string; role: 'lead' | 'moderator' | 'admin'; did: string },
  csrf: string,
  flash: { kind: 'ok' | 'error'; message: string } | null,
): Promise<string> {
  const cfg = getConfig()
  void flash
  const rows = await db
    .select({
      did: modTeam.did,
      role: modTeam.role,
      addedAt: modTeam.addedAt,
      addedBy: modTeam.addedBy,
      handle: accounts.handle,
    })
    .from(modTeam)
    .leftJoin(accounts, eq(accounts.did, modTeam.did))
    .orderBy(asc(modTeam.role), asc(modTeam.addedAt))

  const canMutate = session.role === 'lead' || session.role === 'admin'

  return `
<header>
  <p class="kicker">Roster</p>
  <h1>Moderation team</h1>
  <p class="muted">Lead handle: <code>${escape(cfg.modTeamHandle)}</code> (configure via <code>PDS_MOD_TEAM_HANDLE</code>). The lead is auto-seeded from that handle's account.</p>
</header>

${rows.length === 0
  ? '<p class="muted">No moderators on the roster yet.</p>'
  : `<table>
<thead><tr><th>Handle</th><th>DID</th><th>Role</th><th>Added</th>${canMutate ? '<th></th>' : ''}</tr></thead>
<tbody>${rows
    .map(
      (r) => `<tr>
  <td class="mono">${r.handle ? '@' + escape(r.handle) : '<span class="muted">unresolved</span>'}</td>
  <td class="mono" style="font-size: 11px;">${escape(r.did)}</td>
  <td>${rolePill(r.role)}</td>
  <td class="mono">${escape(r.addedAt.toISOString().slice(0, 10))}</td>
  ${canMutate
    ? r.role === 'lead'
      ? '<td><span class="muted" style="font-size: 11px;">lead seat — rotate via env</span></td>'
      : `<td>
           <form method="POST" action="/mod/team" class="inline-form" onsubmit="return confirm('Remove ${escape(r.handle ?? r.did)} from the team?');">
             <input type="hidden" name="csrf" value="${escape(csrf)}">
             <input type="hidden" name="action" value="remove">
             <input type="hidden" name="did" value="${escape(r.did)}">
             <button type="submit" class="danger" style="padding: 0.2rem 0.6rem; font-size: 11px;">Remove</button>
           </form>
         </td>`
    : ''}
</tr>`,
    )
    .join('')}</tbody>
</table>`}

${canMutate
  ? `<h2>Add a moderator</h2>
<form method="POST" action="/mod/team" class="form">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <input type="hidden" name="action" value="add">
  <label>
    <span>Handle</span>
    <input type="text" name="handle" placeholder="alice.${escape(cfg.hostname)}" required>
  </label>
  <button type="submit" class="primary">Add to team</button>
</form>
<p class="muted" style="font-size: 12px;">The handle must belong to an active account on this PDS. The account's DID is added to <code>mod_team</code> with role <code>moderator</code>; the lead seat is reserved for the <code>PDS_MOD_TEAM_HANDLE</code> account.</p>`
  : '<p class="muted">Only the team lead (or an admin) can change the roster.</p>'}
`
}

function rolePill(role: string): string {
  const cls = role === 'lead' ? 'pill-ok' : ''
  return `<span class="pill ${cls}">${escape(role)}</span>`
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

function forbidden(message: string): Response {
  return new Response(`forbidden: ${message}`, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
