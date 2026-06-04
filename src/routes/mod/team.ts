// GET /mod/team — read-only roster of the moderation team.
//
// Lead + moderator rows from `mod_team`, joined to `accounts` for the
// handle. Add / remove flow is a follow-up; today the bootstrap lead
// is seeded from PDS_MOD_TEAM_HANDLE and additional moderators are
// added via direct DB insert by the operator.

import { createFileRoute } from '@tanstack/react-router'
import { asc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, modTeam } from '~/lib/db/schema'
import { readModSession } from '~/lib/mod-ui/auth'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'
import { getConfig } from '~/lib/config'

export const Route = createFileRoute('/mod/team')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const cfg = getConfig()
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

        const body = `
<header>
  <p class="kicker">Roster</p>
  <h1>Moderation team</h1>
  <p class="muted">Lead handle: <code>${escape(cfg.modTeamHandle)}</code> (configure via <code>PDS_MOD_TEAM_HANDLE</code>)</p>
</header>

${rows.length === 0
  ? '<p class="muted">No moderators on the roster yet.</p>'
  : `<table>
<thead><tr><th>Handle</th><th>DID</th><th>Role</th><th>Added</th></tr></thead>
<tbody>${rows
    .map(
      (r) => `<tr>
  <td class="mono">${r.handle ? '@' + escape(r.handle) : '<span class="muted">unresolved</span>'}</td>
  <td class="mono" style="font-size: 11px;">${escape(r.did)}</td>
  <td>${rolePill(r.role)}</td>
  <td class="mono">${escape(r.addedAt.toISOString().slice(0, 10))}</td>
</tr>`,
    )
    .join('')}</tbody>
</table>`}

<h2>Adding a moderator</h2>
<p class="muted">v1 doesn't ship a UI for this. To add an account as a
moderator, log in to the database and:</p>
<pre class="card" style="font-family: ui-monospace, monospace; font-size: 12px;">INSERT INTO mod_team (did, role, added_by)
VALUES ('did:plc:...', 'moderator', '${escape(session.did)}');</pre>
<p class="muted">The next /mod login by that account will succeed.</p>
`
        return renderModPage({
          title: 'Team',
          currentPath: '/mod/team',
          signedInAs: { handle: session.handle, role: session.role },
          body,
        })
      },
    },
  },
})

function rolePill(role: string): string {
  const cls = role === 'lead' ? 'pill-ok' : ''
  return `<span class="pill ${cls}">${escape(role)}</span>`
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = `/mod/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`
  return new Response(null, { status: 303, headers: { location: target } })
}
