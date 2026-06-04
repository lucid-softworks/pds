// GET  /mod/signatures[?did=…] — research view. Without `did`, shows
//                                  recently-tagged accounts. With `did`,
//                                  shows that account's signatures and
//                                  related accounts (any DID sharing at
//                                  least one signature).
// POST /mod/signatures            — add a signature row to a DID, or
//                                  remove one.

import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accountSignatures, accounts } from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'

export const Route = createFileRoute('/mod/signatures')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)
        const url = new URL(request.url)
        const focus = url.searchParams.get('did')?.trim() ?? null

        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const body = focus
          ? await renderDidView(focus, csrf)
          : await renderRecentList(csrf)
        const res = renderModPage({
          title: focus ? `Signatures: ${focus}` : 'Signatures',
          currentPath: '/mod/signatures',
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
        const did = String(form.get('did') ?? '').trim()
        if (!/^did:(plc|web):/.test(did)) {
          return badRequest('did must be did:plc: or did:web:')
        }
        const actor = session.role === 'admin' ? null : session.did

        if (action === 'add') {
          const property = String(form.get('property') ?? '').trim()
          const value = String(form.get('value') ?? '').trim()
          if (!property || !value) return badRequest('property + value required')
          await db
            .insert(accountSignatures)
            .values({ did, property, value, notedBy: actor })
            .onConflictDoNothing()
        } else if (action === 'remove') {
          const property = String(form.get('property') ?? '').trim()
          const value = String(form.get('value') ?? '').trim()
          if (!property || !value) return badRequest('property + value required')
          await db
            .delete(accountSignatures)
            .where(
              and(
                eq(accountSignatures.did, did),
                eq(accountSignatures.property, property),
                eq(accountSignatures.value, value),
              ),
            )
        } else {
          return badRequest(`unknown action: ${action}`)
        }
        return new Response(null, {
          status: 303,
          headers: { location: `/mod/signatures?did=${encodeURIComponent(did)}` },
        })
      },
    },
  },
})

async function renderRecentList(_csrf: string): Promise<string> {
  // The 25 most recently tagged DIDs (any property/value).
  const rows = await db
    .select({
      did: accountSignatures.did,
      notedAt: sql<Date>`max(${accountSignatures.notedAt})`,
      count: sql<number>`count(*)::int`,
    })
    .from(accountSignatures)
    .groupBy(accountSignatures.did)
    .orderBy(desc(sql`max(${accountSignatures.notedAt})`))
    .limit(25)
  return `
<header>
  <p class="kicker">Research</p>
  <h1>Signatures</h1>
  <p class="muted">
    Per-(did, property, value) fingerprint store. Use it to find
    sock-puppets, repeat offenders, or accounts sharing a hosting
    fingerprint. Look up a specific DID below to see its tags and any
    related accounts.
  </p>
</header>

<h2>Look up a DID</h2>
<form method="GET" action="/mod/signatures" class="form" style="max-width:520px;">
  <label><span>DID</span><input type="text" name="did" placeholder="did:plc:..." required></label>
  <button type="submit" class="primary">Open</button>
</form>

<h2>Recently tagged accounts (${rows.length})</h2>
${rows.length === 0
  ? '<p class="muted">No signatures tagged yet. Open a DID and add the first row.</p>'
  : `<table>
<thead><tr><th>DID</th><th>Last tagged</th><th>#sigs</th></tr></thead>
<tbody>${rows.map((r) => `<tr>
  <td class="mono"><a href="/mod/signatures?did=${encodeURIComponent(r.did)}">${escape(r.did)}</a></td>
  <td class="mono">${escape(formatRelativeTime(r.notedAt))}</td>
  <td class="num">${Number(r.count)}</td>
</tr>`).join('')}</tbody>
</table>`}
`
}

async function renderDidView(did: string, csrf: string): Promise<string> {
  const acctRow = (
    await db
      .select({ handle: accounts.handle })
      .from(accounts)
      .where(eq(accounts.did, did))
      .limit(1)
  )[0]
  const sigs = await db
    .select()
    .from(accountSignatures)
    .where(eq(accountSignatures.did, did))
    .orderBy(desc(accountSignatures.notedAt))

  // Related accounts: any DID sharing a (property, value) with this one.
  let related: Array<{
    did: string
    handle: string | null
    overlaps: Array<{ property: string; value: string }>
  }> = []
  if (sigs.length > 0) {
    const valuePairs = sigs.map((s) => `${s.property} ${s.value}`)
    const rows = await db
      .select({
        did: accountSignatures.did,
        property: accountSignatures.property,
        value: accountSignatures.value,
        handle: accounts.handle,
      })
      .from(accountSignatures)
      .leftJoin(accounts, eq(accounts.did, accountSignatures.did))
      .where(
        sql`${accountSignatures.did} <> ${did} AND
            (${accountSignatures.property} || ' ' || ${accountSignatures.value}) = ANY(${valuePairs})`,
      )
    const byDid = new Map<
      string,
      { did: string; handle: string | null; overlaps: Array<{ property: string; value: string }> }
    >()
    for (const r of rows) {
      const entry = byDid.get(r.did) ?? {
        did: r.did,
        handle: r.handle,
        overlaps: [],
      }
      entry.overlaps.push({ property: r.property, value: r.value })
      byDid.set(r.did, entry)
    }
    related = Array.from(byDid.values()).sort(
      (a, b) => b.overlaps.length - a.overlaps.length,
    )
  }

  return `
<p style="font-size:12px;"><a href="/mod/signatures">← all</a></p>
<header>
  <p class="kicker">Account</p>
  <h1>${acctRow ? '@' + escape(acctRow.handle) : '<span class="muted">unknown</span>'}</h1>
  <p class="muted"><code>${escape(did)}</code></p>
</header>

<h2>Signatures (${sigs.length})</h2>
${sigs.length === 0
  ? '<p class="muted">No signatures tagged on this account yet.</p>'
  : `<table>
<thead><tr><th>Property</th><th>Value</th><th>Noted</th><th></th></tr></thead>
<tbody>${sigs.map((s) => `<tr>
  <td class="mono">${escape(s.property)}</td>
  <td class="mono">${escape(s.value)}</td>
  <td class="mono">${escape(formatRelativeTime(s.notedAt))}</td>
  <td>
    <form method="POST" action="/mod/signatures" class="inline-form">
      <input type="hidden" name="csrf" value="${escape(csrf)}">
      <input type="hidden" name="action" value="remove">
      <input type="hidden" name="did" value="${escape(did)}">
      <input type="hidden" name="property" value="${escape(s.property)}">
      <input type="hidden" name="value" value="${escape(s.value)}">
      <button type="submit" class="danger" style="padding:0.2rem 0.6rem;font-size:11px;">Remove</button>
    </form>
  </td>
</tr>`).join('')}</tbody>
</table>`}

<h2>Add a signature</h2>
<form method="POST" action="/mod/signatures" class="form" style="max-width:520px;">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <input type="hidden" name="action" value="add">
  <input type="hidden" name="did" value="${escape(did)}">
  <label><span>Property</span><input type="text" name="property" placeholder="email | ip | phone | device" required></label>
  <label><span>Value</span><input type="text" name="value" required></label>
  <button type="submit" class="primary">Tag</button>
</form>

<h2>Related accounts (${related.length})</h2>
${related.length === 0
  ? '<p class="muted">No other accounts share any of these signatures.</p>'
  : `<table>
<thead><tr><th>DID / handle</th><th>Overlapping signatures</th></tr></thead>
<tbody>${related.map((r) => `<tr>
  <td class="mono"><a href="/mod/signatures?did=${encodeURIComponent(r.did)}">${r.handle ? '@' + escape(r.handle) : escape(r.did)}</a></td>
  <td>${r.overlaps.map((o) => `<span class="pill">${escape(o.property)}: ${escape(o.value)}</span>`).join(' ')}</td>
</tr>`).join('')}</tbody>
</table>`}
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
