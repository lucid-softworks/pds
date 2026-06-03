// GET /admin/signups — paginated list of every account, newest first.

import { createFileRoute } from '@tanstack/react-router'
import { desc, lt } from 'drizzle-orm'
import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { readAdminSession } from '~/lib/admin-ui/auth'
import {
  escape,
  renderAdminDisabled,
  renderAdminPage,
} from '~/lib/admin-ui/render'

const PAGE_SIZE = 50

export const Route = createFileRoute('/admin/signups')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cfg = getConfig()
        if (!cfg.adminHandle) return renderAdminDisabled()
        const session = await readAdminSession(request)
        if (!session) return redirectToLogin(request)

        const url = new URL(request.url)
        const cursor = url.searchParams.get('cursor')
        const where = cursor ? lt(accounts.createdAt, new Date(cursor)) : undefined
        const rows = await db
          .select({
            did: accounts.did,
            handle: accounts.handle,
            email: accounts.email,
            status: accounts.status,
            emailConfirmedAt: accounts.emailConfirmedAt,
            migrationState: accounts.migrationState,
            createdAt: accounts.createdAt,
          })
          .from(accounts)
          .where(where)
          .orderBy(desc(accounts.createdAt))
          .limit(PAGE_SIZE + 1)

        const hasMore = rows.length > PAGE_SIZE
        const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows
        const last = page[page.length - 1]
        const nextCursor =
          hasMore && last ? new Date(last.createdAt).toISOString() : null

        const body = `
<p class="kicker">Accounts</p>
<h1>Signups</h1>
<p class="muted">${escape(formatTotal(page.length, !!nextCursor))} on this page</p>

${
  page.length === 0
    ? '<p class="muted">No accounts match this page.</p>'
    : `<table>
  <thead><tr>
    <th>Handle</th><th>DID</th><th>Email</th><th>Status</th><th>Email conf.</th><th>Migration</th><th>Created</th>
  </tr></thead>
  <tbody>
  ${page
    .map(
      (a) => `
    <tr>
      <td class="mono">${escape(a.handle)}</td>
      <td class="mono" style="max-width: 280px; overflow: hidden; text-overflow: ellipsis;">${escape(a.did)}</td>
      <td class="mono">${escape(a.email)}</td>
      <td>${statusPill(a.status)}</td>
      <td class="mono">${a.emailConfirmedAt ? `<span class="pill pill-ok">confirmed</span>` : `<span class="pill">pending</span>`}</td>
      <td class="mono">${a.migrationState === 'none' ? '' : `<span class="pill pill-warn">${escape(a.migrationState)}</span>`}</td>
      <td class="mono">${escape(formatDate(a.createdAt))}</td>
    </tr>`,
    )
    .join('')}
  </tbody>
</table>`
}

<div style="margin-top: 1.5rem;">
  ${nextCursor ? `<a class="secondary" href="/admin/signups?cursor=${encodeURIComponent(nextCursor)}" style="display: inline-block; padding: 0.5rem 0.85rem;">older →</a>` : '<span class="muted">end of list</span>'}
  ${cursor ? `<a class="secondary" href="/admin/signups" style="display: inline-block; padding: 0.5rem 0.85rem; margin-left: 0.5rem;">← newest</a>` : ''}
</div>
`
        return renderAdminPage({
          title: 'Signups',
          body,
          currentPath: '/admin/signups',
          adminHandle: session.handle,
        })
      },
    },
  },
})

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = `/admin/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`
  return new Response(null, { status: 303, headers: { location: target } })
}

function statusPill(status: string): string {
  const cls =
    status === 'active'
      ? 'pill-ok'
      : status === 'deleted' || status === 'takendown'
        ? 'pill-err'
        : 'pill-warn'
  return `<span class="pill ${cls}">${escape(status)}</span>`
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function formatTotal(count: number, hasMore: boolean): string {
  return hasMore ? `${count}+ accounts` : `${count} account${count === 1 ? '' : 's'}`
}
