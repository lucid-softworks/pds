// GET  /mod/labels   — label catalog (from the labeler.service record)
//                       + paginated view of recent labels emitted.
// POST /mod/labels   — actions: addValue (extends
//                       policies.labelValueDefinitions on the labeler
//                       record) and removeValue (drops one entry from
//                       both labelValues and labelValueDefinitions).
//
// The labeler's catalog lives on a single record at
// at://<lead-did>/app.bsky.labeler.service/self. Every change here
// rewrites that record via applyWrites — bsky.app's AppView picks up
// the new shape on its next index pass.
//
// Applying labels to individual subjects happens on /mod/subject.
// This page is only about the *catalog* (the definitions the labeler
// offers) and the audit/history view.

import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, lt } from 'drizzle-orm'
import { db } from '~/lib/db'
import { labels, records } from '~/lib/db/schema'
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
import { getBlock } from '~/pds/repo/blockstore'
import { decode, parseCid } from '~/pds/codec'

type LabelValueDef = {
  identifier: string
  severity: 'inform' | 'alert' | 'none'
  blurs: 'content' | 'media' | 'none'
  defaultSetting?: 'ignore' | 'warn' | 'hide'
  adultOnly?: boolean
  locales: Array<{ lang: string; name: string; description: string }>
}

type LabelerServiceRecord = {
  $type: 'app.bsky.labeler.service'
  policies: {
    labelValues?: string[]
    labelValueDefinitions?: LabelValueDef[]
  }
  createdAt: string
  labels?: unknown
}

const PAGE_LIMIT = 50

export const Route = createFileRoute('/mod/labels')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const lead = await getModTeamLead()
        if (!lead) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const url = new URL(request.url)
        const cursorRaw = url.searchParams.get('cursor')
        const cursorSeq = cursorRaw ? Number.parseInt(cursorRaw, 10) : undefined

        const [serviceRecord, recentLabels] = await Promise.all([
          loadLabelerServiceRecord(lead.did),
          db
            .select()
            .from(labels)
            .where(cursorSeq !== undefined ? lt(labels.seq, cursorSeq) : undefined)
            .orderBy(desc(labels.seq))
            .limit(PAGE_LIMIT + 1),
        ])

        const page = recentLabels.slice(0, PAGE_LIMIT)
        const nextCursor =
          recentLabels.length > PAGE_LIMIT && page.length > 0
            ? page[page.length - 1]!.seq
            : null

        const { token: csrf, setCookieHeader: csrfCookie } =
          mintOrReuseCsrf(request)
        const res = renderModPage({
          title: 'Labels',
          currentPath: '/mod/labels',
          signedInAs: { handle: session.handle, role: session.role },
          body: renderBody({ lead, serviceRecord, page, nextCursor, csrf }),
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

        const existing = await loadLabelerServiceRecord(lead.did)
        if (!existing) return badRequest('labeler service record missing')

        let nextPolicies = clonePolicies(existing.value.policies)

        if (action === 'addValue') {
          const identifier = String(form.get('identifier') ?? '').trim()
          if (!/^[a-z][a-z0-9-]{0,127}$/.test(identifier)) {
            return badRequest(
              'identifier must be lowercase ASCII with - allowed (e.g. spam, !hide)',
            )
          }
          const severity = sanitizeEnum(
            form.get('severity'),
            ['inform', 'alert', 'none'],
            'inform',
          )
          const blurs = sanitizeEnum(
            form.get('blurs'),
            ['content', 'media', 'none'],
            'none',
          )
          const description = String(form.get('description') ?? '').trim()
          const name = String(form.get('name') ?? '').trim() || identifier
          const lang = String(form.get('lang') ?? '').trim() || 'en'
          const defaultSetting = sanitizeEnum(
            form.get('defaultSetting'),
            ['ignore', 'warn', 'hide'],
            'warn',
          )
          const adultOnly = form.get('adultOnly') === 'on'

          if (nextPolicies.labelValueDefinitions.some((d) => d.identifier === identifier)) {
            return badRequest(`label value already defined: ${identifier}`)
          }
          nextPolicies.labelValueDefinitions.push({
            identifier,
            severity,
            blurs,
            defaultSetting,
            adultOnly,
            locales: [{ lang, name, description }],
          })
          if (!nextPolicies.labelValues.includes(identifier)) {
            nextPolicies.labelValues.push(identifier)
          }
        } else if (action === 'removeValue') {
          const identifier = String(form.get('identifier') ?? '').trim()
          if (!identifier) return badRequest('identifier required')
          nextPolicies.labelValueDefinitions =
            nextPolicies.labelValueDefinitions.filter(
              (d) => d.identifier !== identifier,
            )
          nextPolicies.labelValues = nextPolicies.labelValues.filter(
            (v) => v !== identifier,
          )
        } else {
          return badRequest(`unknown action: ${action}`)
        }

        const nextRecord: LabelerServiceRecord = {
          ...existing.value,
          $type: 'app.bsky.labeler.service',
          policies: nextPolicies,
        }
        await applyWrites({
          did: lead.did,
          writes: [
            {
              action: 'update',
              collection: 'app.bsky.labeler.service',
              rkey: 'self',
              value: nextRecord,
            },
          ],
        })
        return new Response(null, {
          status: 303,
          headers: { location: '/mod/labels' },
        })
      },
    },
  },
})

async function loadLabelerServiceRecord(did: string): Promise<{
  cid: string
  value: LabelerServiceRecord
} | null> {
  const row = (
    await db
      .select({ cid: records.cid })
      .from(records)
      .where(
        and(
          eq(records.repoDid, did),
          eq(records.collection, 'app.bsky.labeler.service'),
          eq(records.rkey, 'self'),
        ),
      )
      .limit(1)
  )[0]
  if (!row) return null
  const block = await getBlock(did, parseCid(row.cid))
  if (!block) return null
  const value = await decode<LabelerServiceRecord>(block.bytes, block.cid)
  // Defensive normalisation: policies + arrays exist.
  if (!value.policies) value.policies = {}
  if (!value.policies.labelValues) value.policies.labelValues = []
  if (!value.policies.labelValueDefinitions)
    value.policies.labelValueDefinitions = []
  return { cid: row.cid, value }
}

function clonePolicies(
  p: LabelerServiceRecord['policies'],
): { labelValues: string[]; labelValueDefinitions: LabelValueDef[] } {
  return {
    labelValues: [...(p.labelValues ?? [])],
    labelValueDefinitions: (p.labelValueDefinitions ?? []).map((d) => ({
      ...d,
      locales: d.locales.map((l) => ({ ...l })),
    })),
  }
}

function sanitizeEnum<T extends string>(
  raw: FormDataEntryValue | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof raw !== 'string') return fallback
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

function renderBody(args: {
  lead: { did: string; handle: string }
  serviceRecord: { cid: string; value: LabelerServiceRecord } | null
  page: Array<typeof labels.$inferSelect>
  nextCursor: number | null
  csrf: string
}): string {
  const defs = args.serviceRecord?.value.policies.labelValueDefinitions ?? []
  return `
<header>
  <p class="kicker">Labeler</p>
  <h1>Labels</h1>
  <p class="muted">
    Catalog managed on the labeler service record at
    <code>at://${escape(args.lead.did)}/app.bsky.labeler.service/self</code>.
    Edits here rewrite that record; bsky.app's AppView picks up the new
    shape on its next index pass.
  </p>
</header>

<h2>Label value catalog (${defs.length})</h2>
${
  defs.length === 0
    ? '<p class="muted">No label values defined yet. Use the form below to add the first one.</p>'
    : `<table>
<thead><tr><th>Identifier</th><th>Severity</th><th>Blurs</th><th>Default</th><th>Adult only</th><th>Locales</th><th></th></tr></thead>
<tbody>${defs
        .map(
          (d) => `<tr>
  <td class="mono">${escape(d.identifier)}</td>
  <td class="mono">${escape(d.severity)}</td>
  <td class="mono">${escape(d.blurs)}</td>
  <td class="mono">${escape(d.defaultSetting ?? 'warn')}</td>
  <td class="mono">${d.adultOnly ? 'yes' : 'no'}</td>
  <td>${d.locales
    .map(
      (l) =>
        `<div style="font-size:11px;"><strong>${escape(l.lang)}</strong> · ${escape(l.name)} — <span class="muted">${escape(l.description)}</span></div>`,
    )
    .join('')}</td>
  <td>
    <form method="POST" action="/mod/labels" class="inline-form" onsubmit="return confirm('Remove label value ${escape(d.identifier)}?');">
      <input type="hidden" name="csrf" value="${escape(args.csrf)}">
      <input type="hidden" name="action" value="removeValue">
      <input type="hidden" name="identifier" value="${escape(d.identifier)}">
      <button type="submit" class="danger" style="padding:0.2rem 0.6rem;font-size:11px;">Remove</button>
    </form>
  </td>
</tr>`,
        )
        .join('')}</tbody>
</table>`
}

<h2>Add a label value</h2>
<form method="POST" action="/mod/labels" class="form" style="max-width:640px;">
  <input type="hidden" name="csrf" value="${escape(args.csrf)}">
  <input type="hidden" name="action" value="addValue">
  <label>
    <span>Identifier</span>
    <input type="text" name="identifier" placeholder="spam" required pattern="[a-z][a-z0-9-]{0,127}">
  </label>
  <label>
    <span>Display name</span>
    <input type="text" name="name" placeholder="Spam">
  </label>
  <label>
    <span>Description</span>
    <textarea name="description" rows="2" placeholder="Short explanation shown to consumers"></textarea>
  </label>
  <label>
    <span>Severity</span>
    <select name="severity">
      <option value="inform" selected>inform</option>
      <option value="alert">alert</option>
      <option value="none">none</option>
    </select>
  </label>
  <label>
    <span>Blurs</span>
    <select name="blurs">
      <option value="none" selected>none</option>
      <option value="media">media</option>
      <option value="content">content</option>
    </select>
  </label>
  <label>
    <span>Default setting</span>
    <select name="defaultSetting">
      <option value="warn" selected>warn</option>
      <option value="ignore">ignore</option>
      <option value="hide">hide</option>
    </select>
  </label>
  <label style="grid-template-columns:auto 1fr;align-items:center;">
    <input type="checkbox" name="adultOnly" style="width:auto;">
    <span style="text-transform:none;letter-spacing:0;">Adult only</span>
  </label>
  <label>
    <span>Locale lang</span>
    <input type="text" name="lang" value="en" maxlength="8">
  </label>
  <button type="submit" class="primary">Add to catalog</button>
</form>

<h2>Recent emissions (${args.page.length})</h2>
${args.page.length === 0
  ? '<p class="muted">No labels emitted yet. Apply a label from <a href="/mod/subject">a subject view</a> first.</p>'
  : `<table>
<thead><tr><th>seq</th><th>When</th><th>Subject</th><th>Value</th><th>Neg</th></tr></thead>
<tbody>${args.page
      .map(
        (l) => `<tr>
  <td class="mono">${l.seq}</td>
  <td class="mono">${escape(formatRelativeTime(l.cts))}</td>
  <td class="mono">${
    l.uri.startsWith('at://')
      ? `<a href="/mod/subject?q=${encodeURIComponent(l.uri)}">${escape(l.uri)}</a>`
      : `<a href="/mod/subject?q=${encodeURIComponent(l.uri)}">${escape(l.uri)}</a>`
  }</td>
  <td class="mono">${escape(l.val)}</td>
  <td>${l.neg ? '<span class="pill pill-warn">neg</span>' : ''}</td>
</tr>`,
      )
      .join('')}</tbody>
</table>`}

${args.nextCursor !== null
  ? `<p style="margin-top:1.5rem;"><a href="/mod/labels?cursor=${args.nextCursor}">Next page →</a></p>`
  : ''}
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
