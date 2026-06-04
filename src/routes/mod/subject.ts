// GET  /mod/subject?q=<did or at-uri> — render the subject view
//                                       (current status + recent events
//                                       + reports + action forms).
// POST /mod/subject                    — apply a moderation action
//                                       (takedown / reverse / acknowledge
//                                       / escalate / comment / label).
//                                       Routes through applyEmitEvent so
//                                       the side effects, audit, and
//                                       cache are all written from one
//                                       place.

import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import {
  accounts,
  blobs,
  labels,
  modEvents,
  modSubjectStatus,
  moderationReports,
  records,
} from '~/lib/db/schema'
import { readModSession } from '~/lib/mod-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModPage,
  renderModNotProvisioned,
  escape,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'
import { applyEmitEvent, EmitEventInputSchema } from '~/pds/mod/events'
import { readCookie } from '~/lib/admin-ui/auth'
import { MOD_CSRF_COOKIE } from '~/lib/mod-ui/auth'

type Subject =
  | { kind: 'account'; did: string; handle: string }
  | { kind: 'record'; did: string; uri: string; cid: string }

export const Route = createFileRoute('/mod/subject')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const session = await readModSession(request)
        if (!session) return redirectToLogin(request)

        const url = new URL(request.url)
        const q = (url.searchParams.get('q') ?? '').trim()
        if (!q) return redirectTo('/mod')

        const subject = await resolveSubject(q)
        if (!subject) {
          return renderModPage({
            title: 'Subject not found',
            currentPath: '/mod/subject',
            signedInAs: { handle: session.handle, role: session.role },
            body: subjectNotFoundBody(q),
          })
        }

        const csrfExisting = readCookie(request, MOD_CSRF_COOKIE)
        const { token: csrf, setCookieHeader: csrfCookie } = csrfExisting
          ? { token: csrfExisting, setCookieHeader: '' }
          : mintCsrfToken()

        const view = await loadSubjectView(subject)
        const res = renderModPage({
          title: subjectTitle(subject),
          currentPath: '/mod/subject',
          signedInAs: { handle: session.handle, role: session.role },
          body: subjectBody(subject, view, csrf, session.role),
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
        const q = String(form.get('q') ?? '').trim()
        if (!q) return badRequest('missing subject')
        const subject = await resolveSubject(q)
        if (!subject) return badRequest('subject not found')
        const subjectInput =
          subject.kind === 'account'
            ? {
                $type: 'com.atproto.admin.defs#repoRef' as const,
                did: subject.did,
              }
            : {
                $type: 'com.atproto.repo.strongRef' as const,
                uri: subject.uri,
                cid: subject.cid,
              }

        const comment = trimmedOrNull(form.get('comment'))
        const labelVals = parseLabelVals(form.get('labels'))
        const tagVals = parseLabelVals(form.get('tags'))
        const priorityScoreRaw = trimmedOrNull(form.get('priorityScore'))
        const priorityScore = priorityScoreRaw !== null
          ? Number.parseInt(priorityScoreRaw, 10)
          : null
        const emailSubject = trimmedOrNull(form.get('emailSubject'))
        const emailContent = trimmedOrNull(form.get('emailContent'))

        // Synthesise the emitEvent input shape from the form. createdBy
        // is the signed-in moderator's DID, or the team lead's DID when
        // the operator is using admin Basic.
        const lead = await getModTeamLead()
        const createdBy = session.role === 'admin'
          ? lead?.did ?? null
          : session.did
        if (!createdBy) return badRequest('createdBy unresolved')

        const event = buildEventForAction(action, {
          comment,
          labelVals,
          tagVals,
          priorityScore,
          emailSubject,
          emailContent,
        })
        if (!event) return badRequest(`unknown action: ${action}`)

        const input = EmitEventInputSchema.safeParse({
          event,
          subject: subjectInput,
          createdBy,
        })
        if (!input.success) {
          return badRequest(
            input.error.issues.map((i) => i.message).join('; '),
          )
        }
        await applyEmitEvent({
          input: input.data,
          labelSrcDid: lead?.did ?? null,
        })

        return redirectTo(`/mod/subject?q=${encodeURIComponent(q)}`)
      },
    },
  },
})

async function resolveSubject(q: string): Promise<Subject | null> {
  if (q.startsWith('at://')) {
    const rest = q.slice('at://'.length)
    const [did, collection, rkey] = rest.split('/')
    if (!did || !collection || !rkey) return null
    const rows = await db
      .select({
        cid: records.cid,
        handle: accounts.handle,
      })
      .from(records)
      .innerJoin(accounts, eq(accounts.did, records.repoDid))
      .where(
        and(
          eq(records.repoDid, did),
          eq(records.collection, collection),
          eq(records.rkey, rkey),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return { kind: 'record', did, uri: q, cid: row.cid }
  }
  if (/^did:/.test(q)) {
    const rows = await db
      .select({ did: accounts.did, handle: accounts.handle })
      .from(accounts)
      .where(eq(accounts.did, q))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return { kind: 'account', did: row.did, handle: row.handle }
  }
  return null
}

async function loadSubjectView(subject: Subject) {
  const subjectWhere =
    subject.kind === 'account'
      ? and(
          eq(modSubjectStatus.subjectDid, subject.did),
          isNull(modSubjectStatus.subjectUri),
        )
      : eq(modSubjectStatus.subjectUri, subject.uri)

  const [statusRow] = await db
    .select()
    .from(modSubjectStatus)
    .where(subjectWhere)
    .limit(1)

  const eventsRows = await db
    .select()
    .from(modEvents)
    .where(
      subject.kind === 'account'
        ? or(
            eq(modEvents.subjectDid, subject.did),
            sql`${modEvents.subjectUri} LIKE ${`at://${subject.did}/%`}`,
          )
        : eq(modEvents.subjectUri, subject.uri),
    )
    .orderBy(desc(modEvents.id))
    .limit(50)

  const reportsRows = await db
    .select()
    .from(moderationReports)
    .where(
      subject.kind === 'account'
        ? eq(moderationReports.subjectDid, subject.did)
        : eq(moderationReports.subjectUri, subject.uri),
    )
    .orderBy(desc(moderationReports.createdAt))
    .limit(50)

  let currentTakedownRef: string | null = null
  if (subject.kind === 'record') {
    const r = await db
      .select({ ref: records.takedownRef })
      .from(records)
      .where(
        and(
          eq(records.repoDid, subject.did),
          sql`${records.cid} = ${subject.cid}`,
        ),
      )
      .limit(1)
    currentTakedownRef = r[0]?.ref ?? null
  } else {
    const a = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, subject.did))
      .limit(1)
    if (a[0]?.status === 'takendown') currentTakedownRef = 'account-status'
  }

  const labelsRows =
    subject.kind === 'account'
      ? await db
          .select()
          .from(labels)
          .where(eq(labels.uri, subject.did))
          .orderBy(desc(labels.seq))
      : await db
          .select()
          .from(labels)
          .where(eq(labels.uri, subject.uri))
          .orderBy(desc(labels.seq))

  return {
    status: statusRow ?? null,
    events: eventsRows,
    reports: reportsRows,
    currentTakedownRef,
    labels: labelsRows,
  }
}

function subjectTitle(s: Subject): string {
  return s.kind === 'account' ? `@${s.handle}` : s.uri
}

function subjectBody(
  s: Subject,
  view: Awaited<ReturnType<typeof loadSubjectView>>,
  csrf: string,
  role: 'lead' | 'moderator' | 'admin',
): string {
  const subjectHeader =
    s.kind === 'account'
      ? `<header>
  <p class="kicker">Account</p>
  <h1>@${escape(s.handle)}</h1>
  <p class="muted"><code>${escape(s.did)}</code></p>
</header>`
      : `<header>
  <p class="kicker">Record</p>
  <h1>${escape(s.uri)}</h1>
  <p class="muted">cid <code>${escape(s.cid)}</code></p>
</header>`

  const tags = view.status?.tags ?? []
  const priorityScore = view.status?.priorityScore ?? null
  const appealState = view.status?.appealState ?? null
  const stateRow = `
<div class="grid grid-3">
  <div class="card">
    <div class="stat-label">Status</div>
    <div class="stat-value" style="font-size: 1.25rem;">
      ${view.currentTakedownRef ? '<span class="pill pill-err">takendown</span>' : '<span class="pill pill-ok">visible</span>'}
    </div>
    ${view.currentTakedownRef ? `<div class="stat-sub">ref: ${escape(view.currentTakedownRef)}</div>` : ''}
  </div>
  <div class="card">
    <div class="stat-label">Review state</div>
    <div class="stat-value" style="font-size: 1.25rem;">${escape(view.status?.reviewState ?? 'open')}</div>
    ${view.status?.lastEventAt ? `<div class="stat-sub">last event ${escape(formatRelativeTime(view.status.lastEventAt))}</div>` : ''}
    ${appealState ? `<div class="stat-sub">appeal: ${escape(appealState)}</div>` : ''}
  </div>
  <div class="card">
    <div class="stat-label">Labels</div>
    <div class="stat-value" style="font-size: 1.25rem;">${view.labels.length}</div>
    ${view.labels.length > 0
      ? `<div class="stat-sub">${view.labels.slice(0, 6).map((l) => `<span class="pill ${l.neg ? 'pill-warn' : 'pill-ok'}">${escape(l.val)}${l.neg ? ' (neg)' : ''}</span>`).join(' ')}</div>`
      : ''}
  </div>
</div>
${tags.length > 0 || priorityScore !== null
  ? `<div class="grid grid-2" style="margin-top:1rem;">
       ${tags.length > 0 ? `
         <div class="card">
           <div class="stat-label">Tags</div>
           <div class="stat-sub" style="margin-top:0.5rem;">${tags.map((t) => `<span class="pill">${escape(t)}</span>`).join(' ')}</div>
         </div>` : ''}
       ${priorityScore !== null ? `
         <div class="card">
           <div class="stat-label">Priority</div>
           <div class="stat-value" style="font-size:1.25rem;">${priorityScore}</div>
           <div class="stat-sub">0..100</div>
         </div>` : ''}
     </div>`
  : ''}`

  const isAccount = s.kind === 'account'
  const actionForm = `
<h2>Apply moderation action</h2>
<form method="POST" action="/mod/subject" class="form" style="max-width:720px;">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <input type="hidden" name="q" value="${escape(s.kind === 'account' ? s.did : s.uri)}">
  <label>
    <span>Comment (optional, recorded on the event)</span>
    <textarea name="comment" rows="2" placeholder="reason / note for the audit log"></textarea>
  </label>
  <div class="grid grid-2">
    <label>
      <span>Labels (comma-separated; for label / negate-labels)</span>
      <input type="text" name="labels" placeholder="e.g. spam, !hide">
    </label>
    <label>
      <span>Tags (comma-separated; for tag action)</span>
      <input type="text" name="tags" placeholder="e.g. priority-review">
    </label>
    <label>
      <span>Priority score (0..100; for priorityScore)</span>
      <input type="number" name="priorityScore" min="0" max="100" placeholder="50">
    </label>
    ${isAccount ? `
    <label>
      <span>Email subject + body (for email)</span>
      <input type="text" name="emailSubject" placeholder="subject line">
      <textarea name="emailContent" rows="3" style="margin-top:0.25rem;" placeholder="content (markdown)"></textarea>
    </label>` : ''}
  </div>
  <div class="action-row">
    ${view.currentTakedownRef
      ? `<button type="submit" class="secondary" name="action" value="reverseTakedown">Reverse takedown</button>`
      : `<button type="submit" class="danger" name="action" value="takedown">Takedown</button>`}
    <button type="submit" class="secondary" name="action" value="acknowledge">Acknowledge</button>
    <button type="submit" class="secondary" name="action" value="escalate">Escalate</button>
    <button type="submit" class="secondary" name="action" value="comment">Comment only</button>
    <button type="submit" class="secondary" name="action" value="label">Apply labels</button>
    <button type="submit" class="secondary" name="action" value="negate-labels">Negate labels</button>
    <button type="submit" class="secondary" name="action" value="tag">Tag</button>
    <button type="submit" class="secondary" name="action" value="priorityScore">Set priority</button>
    <button type="submit" class="secondary" name="action" value="resolveAppeal">Resolve appeal</button>
    ${isAccount ? `
      <button type="submit" class="secondary" name="action" value="divert">Divert</button>
      <button type="submit" class="secondary" name="action" value="email">Send email</button>
      <button type="submit" class="secondary" name="action" value="muteReporter">Mute as reporter</button>
      <button type="submit" class="secondary" name="action" value="unmuteReporter">Unmute as reporter</button>
      <button type="submit" class="danger" name="action" value="revokeAccountCredentials" onclick="return confirm('Sign this account out of every device?');">Revoke credentials</button>
    ` : ''}
  </div>
  ${role === 'admin' ? '<p class="muted" style="font-size: 12px;">acting as admin (Basic). createdBy will be set to the team lead.</p>' : ''}
</form>`

  const reportsTable =
    view.reports.length === 0
      ? '<p class="muted">No reports for this subject.</p>'
      : `<table>
  <thead><tr><th>When</th><th>Reason</th><th>Reporter</th><th>Note</th></tr></thead>
  <tbody>${view.reports
    .map(
      (r) => `<tr>
        <td class="mono">${escape(formatRelativeTime(r.createdAt))}</td>
        <td class="mono">${escape(r.reasonType)}</td>
        <td class="mono">${escape(r.reportedByDid)}</td>
        <td>${escape(r.reason ?? '')}</td>
      </tr>`,
    )
    .join('')}</tbody>
</table>`

  const eventsTable =
    view.events.length === 0
      ? '<p class="muted">No moderation events yet for this subject.</p>'
      : `<table>
  <thead><tr><th>When</th><th>Type</th><th>By</th><th>Comment</th></tr></thead>
  <tbody>${view.events
    .map(
      (e) => `<tr>
        <td class="mono">${escape(formatRelativeTime(e.createdAt))}</td>
        <td class="mono"><span class="pill ${eventTypePill(e.eventType)}">${escape(e.eventType)}</span></td>
        <td class="mono">${escape(e.createdByDid)}</td>
        <td>${escape(e.comment ?? '')}</td>
      </tr>`,
    )
    .join('')}</tbody>
</table>`

  return `${subjectHeader}
${stateRow}
${actionForm}
<h2>Reports (${view.reports.length})</h2>
${reportsTable}
<h2>Event history (${view.events.length})</h2>
${eventsTable}`
}

function eventTypePill(t: string): string {
  if (t === 'modEventTakedown') return 'pill-err'
  if (t === 'modEventReverseTakedown') return 'pill-ok'
  if (t === 'modEventLabel') return 'pill-warn'
  return ''
}

function subjectNotFoundBody(q: string): string {
  return `<header>
  <p class="kicker">Not found</p>
  <h1>Subject not found</h1>
  <p class="muted">No account or record matches <code>${escape(q)}</code> on this PDS.</p>
</header>
<p><a href="/mod">← back to dashboard</a></p>`
}

function buildEventForAction(
  action: string,
  form: {
    comment: string | null
    labelVals: string[]
    tagVals: string[]
    priorityScore: number | null
    emailSubject: string | null
    emailContent: string | null
  },
):
  | { $type: string; [k: string]: unknown }
  | null {
  const { comment, labelVals, tagVals, priorityScore, emailSubject, emailContent } = form
  switch (action) {
    case 'takedown':
      return {
        $type: 'tools.ozone.moderation.defs#modEventTakedown',
        ...(comment ? { comment } : {}),
      }
    case 'reverseTakedown':
      return {
        $type: 'tools.ozone.moderation.defs#modEventReverseTakedown',
        ...(comment ? { comment } : {}),
      }
    case 'acknowledge':
      return {
        $type: 'tools.ozone.moderation.defs#modEventAcknowledge',
        ...(comment ? { comment } : {}),
      }
    case 'escalate':
      return {
        $type: 'tools.ozone.moderation.defs#modEventEscalate',
        ...(comment ? { comment } : {}),
      }
    case 'comment':
      return {
        $type: 'tools.ozone.moderation.defs#modEventComment',
        ...(comment ? { comment } : { comment: '(no comment)' }),
      }
    case 'label':
      if (labelVals.length === 0) return null
      return {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        createLabelVals: labelVals,
        ...(comment ? { comment } : {}),
      }
    case 'negate-labels':
      if (labelVals.length === 0) return null
      return {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        negateLabelVals: labelVals,
        ...(comment ? { comment } : {}),
      }
    case 'tag':
      if (tagVals.length === 0) return null
      return {
        $type: 'tools.ozone.moderation.defs#modEventTag',
        add: tagVals,
        ...(comment ? { comment } : {}),
      }
    case 'priorityScore':
      if (priorityScore === null || !Number.isFinite(priorityScore)) {
        return null
      }
      return {
        $type: 'tools.ozone.moderation.defs#modEventPriorityScore',
        score: priorityScore,
        ...(comment ? { comment } : {}),
      }
    case 'resolveAppeal':
      return {
        $type: 'tools.ozone.moderation.defs#modEventResolveAppeal',
        ...(comment ? { comment } : {}),
      }
    case 'divert':
      return {
        $type: 'tools.ozone.moderation.defs#modEventDivert',
        ...(comment ? { comment } : {}),
      }
    case 'muteReporter':
      return {
        $type: 'tools.ozone.moderation.defs#modEventMuteReporter',
        ...(comment ? { comment } : {}),
      }
    case 'unmuteReporter':
      return {
        $type: 'tools.ozone.moderation.defs#modEventUnmuteReporter',
        ...(comment ? { comment } : {}),
      }
    case 'email':
      if (!emailSubject && !emailContent) return null
      return {
        $type: 'tools.ozone.moderation.defs#modEventEmail',
        ...(emailSubject ? { subjectLine: emailSubject } : {}),
        ...(emailContent ? { content: emailContent } : {}),
        ...(comment ? { comment } : {}),
      }
    case 'revokeAccountCredentials':
      return {
        $type: 'tools.ozone.moderation.defs#revokeAccountCredentialsEvent',
        ...(comment ? { comment } : {}),
      }
    default:
      return null
  }
}

function parseLabelVals(raw: FormDataEntryValue | null): string[] {
  if (raw === null) return []
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function trimmedOrNull(raw: FormDataEntryValue | null): string | null {
  if (raw === null) return null
  const s = String(raw).trim()
  return s.length > 0 ? s : null
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const target = `/mod/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`
  return new Response(null, { status: 303, headers: { location: target } })
}

function redirectTo(target: string): Response {
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

// Suppress unused-import warnings for cross-file types pulled in via the
// blobs schema import (we'll add blob-level subject support in a follow-
// up; the import here keeps the migration story honest).
void blobs
