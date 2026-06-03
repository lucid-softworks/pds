// GET /admin — dashboard. Shows current counts + a sliver of recent
// signups + recent invite-code activity, with deep links into the
// sub-pages.

import { createFileRoute } from '@tanstack/react-router'
import { desc } from 'drizzle-orm'
import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { accounts, inviteCodes } from '~/lib/db/schema'
import { readAdminSession } from '~/lib/admin-ui/auth'
import { escape, renderAdminDisabled, renderAdminPage } from '~/lib/admin-ui/render'
import { getPdsStats } from '~/lib/stats.server'
import { formatCount, formatBytes } from '~/lib/stats'

export const Route = createFileRoute('/admin/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cfg = getConfig()
        if (!cfg.adminHandle) return renderAdminDisabled()
        const session = await readAdminSession(request)
        if (!session) return redirectToLogin(request)

        const [stats, recentAccounts, recentCodes] = await Promise.all([
          getPdsStats(),
          db
            .select({
              did: accounts.did,
              handle: accounts.handle,
              email: accounts.email,
              status: accounts.status,
              createdAt: accounts.createdAt,
            })
            .from(accounts)
            .orderBy(desc(accounts.createdAt))
            .limit(5),
          db
            .select({
              code: inviteCodes.code,
              usesRemaining: inviteCodes.usesRemaining,
              usesTotal: inviteCodes.usesTotal,
              disabled: inviteCodes.disabled,
              createdAt: inviteCodes.createdAt,
            })
            .from(inviteCodes)
            .orderBy(desc(inviteCodes.createdAt))
            .limit(5),
        ])

        const body = `
<p class="kicker">Overview</p>
<h1>${escape(cfg.hostname)}</h1>
<p class="muted">${escape(cfg.publicUrl)} · ${escape(cfg.serviceDid)}</p>

<div class="grid grid-4" style="margin-top: 1.5rem;">
  <div class="card">
    <div class="stat-label">Accounts</div>
    <div class="stat-value">${formatCount(stats.accounts.active)}</div>
    <div class="stat-sub">${formatCount(stats.accounts.total)} total · ${formatCount(stats.accounts.deactivated)} deactivated · ${formatCount(stats.accounts.takendown)} takendown</div>
  </div>
  <div class="card">
    <div class="stat-label">Records</div>
    <div class="stat-value">${formatCount(stats.content.records)}</div>
    <div class="stat-sub">across ${formatCount(stats.content.repos)} repos</div>
  </div>
  <div class="card">
    <div class="stat-label">Blobs</div>
    <div class="stat-value">${formatCount(stats.content.blobs.count)}</div>
    <div class="stat-sub">${escape(formatBytes(stats.content.blobs.bytes))}</div>
  </div>
  <div class="card">
    <div class="stat-label">Firehose</div>
    <div class="stat-value">${formatCount(stats.firehose.latestSeq)}</div>
    <div class="stat-sub">${formatCount(stats.firehose.eventCounts.commit)} commits · ${formatCount(stats.firehose.eventCounts.identity)} identity · ${formatCount(stats.firehose.eventCounts.account)} account</div>
  </div>
</div>

<h2>Recent signups <a href="/admin/signups" style="font-size: 12px; font-weight: 400; margin-left: 0.5rem;">see all →</a></h2>
${
  recentAccounts.length === 0
    ? '<p class="muted">No accounts yet.</p>'
    : `<table>
  <thead><tr><th>Handle</th><th>Email</th><th>Status</th><th>Created</th></tr></thead>
  <tbody>
  ${recentAccounts
    .map(
      (a) => `
    <tr>
      <td class="mono">${escape(a.handle)}</td>
      <td class="mono">${escape(a.email)}</td>
      <td>${statusPill(a.status)}</td>
      <td class="mono">${escape(formatRelativeTime(a.createdAt))}</td>
    </tr>`,
    )
    .join('')}
  </tbody>
</table>`
}

<h2>Recent invite codes <a href="/admin/invites" style="font-size: 12px; font-weight: 400; margin-left: 0.5rem;">manage →</a></h2>
${
  recentCodes.length === 0
    ? `<p class="muted">No invite codes yet. ${cfg.inviteRequired ? 'Signup is currently gated — <a href="/admin/invites">mint a code</a> before users can register.' : 'Open signup is on (set <code>PDS_INVITE_REQUIRED=true</code> to gate it).'}</p>`
    : `<table>
  <thead><tr><th>Code</th><th>Uses left</th><th>Used</th><th>Status</th><th>Created</th></tr></thead>
  <tbody>
  ${recentCodes
    .map(
      (c) => `
    <tr>
      <td class="mono">${escape(c.code)}</td>
      <td class="num">${c.usesRemaining}</td>
      <td class="num">${c.usesTotal}</td>
      <td>${invitePill(c)}</td>
      <td class="mono">${escape(formatRelativeTime(c.createdAt))}</td>
    </tr>`,
    )
    .join('')}
  </tbody>
</table>`
}
`
        return renderAdminPage({
          title: 'Dashboard',
          body,
          currentPath: '/admin',
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

function invitePill(c: { disabled: boolean; usesRemaining: number }): string {
  if (c.disabled) return `<span class="pill pill-err">disabled</span>`
  if (c.usesRemaining === 0) return `<span class="pill pill-warn">exhausted</span>`
  return `<span class="pill pill-ok">active</span>`
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
