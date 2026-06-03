// GET /admin/invites — list every invite code + mint form.
// POST /admin/invites — mint a new code (form submission).
// POST /admin/invites/disable — flip the `disabled` flag on one code.
//
// CSRF is enforced on POST via double-submit cookie (`pds_admin_csrf`).

import { createFileRoute } from '@tanstack/react-router'
import { desc, eq } from 'drizzle-orm'
import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { inviteCodes, accounts } from '~/lib/db/schema'
import { readAdminSession, ADMIN_CSRF_COOKIE, readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/admin-ui/csrf'
import { createOneInviteCode } from '~/pds/account/invites'
import {
  escape,
  renderAdminDisabled,
  renderAdminPage,
} from '~/lib/admin-ui/render'

const MAX_LISTED = 200

export const Route = createFileRoute('/admin/invites')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return handleGet(request, null)
      },
      POST: async ({ request }) => {
        const cfg = getConfig()
        if (!cfg.adminHandle) return renderAdminDisabled()
        const session = await readAdminSession(request)
        if (!session) return redirectToLogin(request)

        const url = new URL(request.url)
        const form = await request.formData()
        const csrfField = form.get('csrf')
        if (typeof csrfField !== 'string' || !verifyCsrf(request, csrfField)) {
          return handleGet(request, {
            kind: 'error',
            message: 'CSRF check failed; reload and try again',
          })
        }

        const action = url.pathname.endsWith('/disable')
          ? 'disable'
          : String(form.get('action') ?? 'mint')

        if (action === 'mint') {
          const useCountRaw = String(form.get('useCount') ?? '1').trim()
          const useCount = Number.parseInt(useCountRaw, 10)
          const forAccount = String(form.get('forAccount') ?? '').trim() || null
          if (!Number.isFinite(useCount) || useCount < 1 || useCount > 10000) {
            return handleGet(request, {
              kind: 'error',
              message: '`uses` must be a positive integer ≤ 10000',
            })
          }
          if (forAccount && !forAccount.startsWith('did:')) {
            return handleGet(request, {
              kind: 'error',
              message: '`forAccount` must be a DID (did:plc:...)',
            })
          }
          if (forAccount) {
            // Soft-validate: warn (not error) if the DID isn't known locally;
            // the operator might be minting for an inbound migration.
            const row = (
              await db
                .select({ did: accounts.did })
                .from(accounts)
                .where(eq(accounts.did, forAccount))
                .limit(1)
            )[0]
            if (!row) {
              return handleGet(request, {
                kind: 'error',
                message: `forAccount ${forAccount} is not a known account; double-check the DID`,
              })
            }
          }
          const result = await createOneInviteCode({
            createdBy: null,
            forAccount,
            usesRemaining: useCount,
          })
          return handleGet(request, {
            kind: 'ok',
            message: `minted code ${result.code} (${useCount} use${useCount === 1 ? '' : 's'})`,
          })
        }

        if (action === 'disable') {
          const code = String(form.get('code') ?? '').trim()
          if (!code) {
            return handleGet(request, {
              kind: 'error',
              message: 'missing `code` field',
            })
          }
          await db
            .update(inviteCodes)
            .set({ disabled: true })
            .where(eq(inviteCodes.code, code))
          return handleGet(request, {
            kind: 'ok',
            message: `disabled ${code}`,
          })
        }

        return handleGet(request, {
          kind: 'error',
          message: `unknown action: ${action}`,
        })
      },
    },
  },
})

async function handleGet(
  request: Request,
  flash: { kind: 'ok' | 'error'; message: string } | null,
): Promise<Response> {
  const cfg = getConfig()
  if (!cfg.adminHandle) return renderAdminDisabled()
  const session = await readAdminSession(request)
  if (!session) return redirectToLogin(request)

  const rows = await db
    .select({
      code: inviteCodes.code,
      forAccount: inviteCodes.forAccount,
      usesRemaining: inviteCodes.usesRemaining,
      usesTotal: inviteCodes.usesTotal,
      disabled: inviteCodes.disabled,
      createdAt: inviteCodes.createdAt,
    })
    .from(inviteCodes)
    .orderBy(desc(inviteCodes.createdAt))
    .limit(MAX_LISTED)

  const existingCsrf = readCookie(request, ADMIN_CSRF_COOKIE)
  const { token: csrfToken, setCookieHeader } = existingCsrf
    ? { token: existingCsrf, setCookieHeader: '' }
    : mintCsrfToken()

  const policyPill = cfg.inviteRequired
    ? `<span class="pill pill-ok">invite required</span>`
    : `<span class="pill pill-warn">open signup</span>`

  const body = `
<p class="kicker">Invites</p>
<h1>Invite codes</h1>
<p class="muted">Signup policy: ${policyPill} (set <code>PDS_INVITE_REQUIRED</code> in env)</p>

<div class="card" style="margin-top: 1.5rem;">
  <h2 style="margin-top: 0;">Mint a new code</h2>
  <form action="/admin/invites" method="POST" class="form">
    <input type="hidden" name="csrf" value="${escape(csrfToken)}">
    <input type="hidden" name="action" value="mint">
    <label>
      <span>Number of uses</span>
      <input type="number" name="useCount" min="1" max="10000" value="1" required>
    </label>
    <label>
      <span>For account (optional DID)</span>
      <input type="text" name="forAccount" placeholder="did:plc:…">
    </label>
    <button type="submit" class="primary">Mint code</button>
  </form>
</div>

<h2>All codes (showing latest ${rows.length})</h2>
${
  rows.length === 0
    ? '<p class="muted">No codes yet.</p>'
    : `<table>
  <thead><tr>
    <th>Code</th><th>Uses left</th><th>Used</th><th>For DID</th><th>Status</th><th>Created</th><th></th>
  </tr></thead>
  <tbody>
  ${rows
    .map(
      (c) => `
    <tr>
      <td class="mono">${escape(c.code)}</td>
      <td class="num">${c.usesRemaining}</td>
      <td class="num">${c.usesTotal}</td>
      <td class="mono">${escape(c.forAccount ?? '—')}</td>
      <td>${invitePill(c)}</td>
      <td class="mono">${escape(formatDate(c.createdAt))}</td>
      <td>${
        c.disabled
          ? ''
          : `<form action="/admin/invites" method="POST" class="inline-form">
              <input type="hidden" name="csrf" value="${escape(csrfToken)}">
              <input type="hidden" name="action" value="disable">
              <input type="hidden" name="code" value="${escape(c.code)}">
              <button type="submit" class="danger">disable</button>
            </form>`
      }</td>
    </tr>`,
    )
    .join('')}
  </tbody>
</table>`
}
`

  const res = renderAdminPage({
    title: 'Invite codes',
    body,
    currentPath: '/admin/invites',
    adminHandle: session.handle,
    flash,
  })
  if (setCookieHeader) {
    res.headers.append('set-cookie', setCookieHeader)
  }
  return res
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = `/admin/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`
  return new Response(null, { status: 303, headers: { location: target } })
}

function invitePill(c: { disabled: boolean; usesRemaining: number }): string {
  if (c.disabled) return `<span class="pill pill-err">disabled</span>`
  if (c.usesRemaining === 0) return `<span class="pill pill-warn">exhausted</span>`
  return `<span class="pill pill-ok">active</span>`
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toISOString().slice(0, 16).replace('T', ' ')
}
