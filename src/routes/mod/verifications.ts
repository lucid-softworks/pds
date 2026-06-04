// GET  /mod/verifications — list issued verifications + grant form.
// POST /mod/verifications — grant a single verification (writes the
//                            record into the labeler's repo + index
//                            row) or revoke one (delete record + row).
//                            For batch flows, use the XRPC directly.

import { createFileRoute } from '@tanstack/react-router'
import { desc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, verificationsIndex } from '~/lib/db/schema'
import { readModSession, MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'
import { applyWrites } from '~/pds/repo/writes'

export const Route = createFileRoute('/mod/verifications')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const lead = await getModTeamLead()
        if (!lead) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)
        const rows = await db
          .select()
          .from(verificationsIndex)
          .orderBy(desc(verificationsIndex.createdAt))
          .limit(200)
        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Verifications',
          currentPath: '/mod/verifications',
          signedInAs: { handle: session.handle, role: session.role },
          body: renderBody({ rows, csrf, leadHandle: lead.handle }),
        })
        if (csrfCookie) res.headers.set('set-cookie', csrfCookie)
        return res
      },

      POST: async ({ request }) => {
        const lead = await getModTeamLead()
        if (!lead) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)
        const form = await request.formData()
        const csrf = form.get('csrf')
        if (typeof csrf !== 'string' || !verifyCsrf(request, csrf)) {
          return badRequest('session expired, try again')
        }
        const action = String(form.get('action') ?? '')

        if (action === 'grant') {
          const subject = String(form.get('subject') ?? '').trim()
          const handle = String(form.get('handle') ?? '').trim()
          const displayName =
            String(form.get('displayName') ?? '').trim() || null
          if (!/^did:(plc|web):/.test(subject)) {
            return badRequest('subject must be a DID')
          }
          if (!handle) return badRequest('handle required')
          const found = await db
            .select({ did: accounts.did, status: accounts.status })
            .from(accounts)
            .where(eq(accounts.did, subject))
            .limit(1)
          if (found.length === 0 || found[0]!.status !== 'active') {
            return badRequest(`no active account on this PDS for ${subject}`)
          }
          const createdAt = new Date().toISOString()
          const result = await applyWrites({
            did: lead.did,
            writes: [
              {
                action: 'create',
                collection: 'app.bsky.graph.verification',
                value: {
                  $type: 'app.bsky.graph.verification',
                  subject,
                  handle,
                  ...(displayName !== null ? { displayName } : {}),
                  createdAt,
                },
              },
            ],
          })
          const w = result.writes[0]!
          if (w.action !== 'create' || w.cid === null) {
            return badRequest('unexpected write shape')
          }
          await db
            .insert(verificationsIndex)
            .values({
              uri: w.uri,
              cid: w.cid.toString(),
              issuerDid: lead.did,
              subjectDid: subject,
              handle,
              displayName,
              createdAt: new Date(createdAt),
            })
            .onConflictDoNothing({ target: verificationsIndex.uri })
        } else if (action === 'revoke') {
          const uri = String(form.get('uri') ?? '').trim()
          if (!uri.startsWith('at://')) return badRequest('invalid uri')
          const row = (
            await db
              .select()
              .from(verificationsIndex)
              .where(eq(verificationsIndex.uri, uri))
              .limit(1)
          )[0]
          if (!row) return badRequest('not found')
          const { repoDid, collection, rkey } = parseAtUri(uri)
          if (repoDid !== row.issuerDid) {
            return badRequest('uri / issuer mismatch')
          }
          await applyWrites({
            did: row.issuerDid,
            writes: [{ action: 'delete', collection, rkey }],
          })
          await db
            .delete(verificationsIndex)
            .where(eq(verificationsIndex.uri, uri))
        } else {
          return badRequest(`unknown action: ${action}`)
        }

        return new Response(null, {
          status: 303,
          headers: { location: '/mod/verifications' },
        })
      },
    },
  },
})

function renderBody(args: {
  rows: Array<typeof verificationsIndex.$inferSelect>
  csrf: string
  leadHandle: string
}): string {
  return `
<header>
  <p class="kicker">Verification</p>
  <h1>Verifications</h1>
  <p class="muted">
    Each grant is an <code>app.bsky.graph.verification</code> record in
    <code>@${escape(args.leadHandle)}</code>'s repo. Consumers fetch
    these via <code>tools.ozone.verification.listVerifications</code>
    and apply them as verified-account markers.
  </p>
</header>

<h2>Active grants (${args.rows.length})</h2>
${args.rows.length === 0
  ? '<p class="muted">None yet.</p>'
  : `<table>
<thead><tr><th>Subject DID</th><th>Handle</th><th>Display name</th><th>Issued</th><th></th></tr></thead>
<tbody>${args.rows.map((r) => `<tr>
  <td class="mono" style="font-size:11px;">${escape(r.subjectDid)}</td>
  <td class="mono">@${escape(r.handle)}</td>
  <td>${escape(r.displayName ?? '')}</td>
  <td class="mono">${escape(formatRelativeTime(r.createdAt))}</td>
  <td>
    <form method="POST" action="/mod/verifications" class="inline-form" onsubmit="return confirm('Revoke verification for @${escape(r.handle)}?');">
      <input type="hidden" name="csrf" value="${escape(args.csrf)}">
      <input type="hidden" name="action" value="revoke">
      <input type="hidden" name="uri" value="${escape(r.uri)}">
      <button type="submit" class="danger" style="padding:0.2rem 0.6rem;font-size:11px;">Revoke</button>
    </form>
  </td>
</tr>`).join('')}</tbody>
</table>`}

<h2>Grant a verification</h2>
<form method="POST" action="/mod/verifications" class="form" style="max-width:520px;">
  <input type="hidden" name="csrf" value="${escape(args.csrf)}">
  <input type="hidden" name="action" value="grant">
  <label><span>Subject DID</span><input type="text" name="subject" placeholder="did:plc:..." required></label>
  <label><span>Handle (observed)</span><input type="text" name="handle" placeholder="alice.example.com" required></label>
  <label><span>Display name (optional)</span><input type="text" name="displayName" placeholder="Alice"></label>
  <button type="submit" class="primary">Grant</button>
</form>
<p class="muted" style="font-size:12px;">
  Subject must be an active account on this PDS. For cross-PDS verification
  use the <code>tools.ozone.verification.grantVerifications</code> XRPC
  directly.
</p>
`
}

function parseAtUri(uri: string): {
  repoDid: string
  collection: string
  rkey: string
} {
  const rest = uri.slice('at://'.length)
  const [did, collection, rkey] = rest.split('/')
  if (!did || !collection || !rkey) {
    throw new Error(`invalid AT-URI: ${uri}`)
  }
  return { repoDid: did, collection, rkey }
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
