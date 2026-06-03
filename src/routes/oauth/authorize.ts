// TanStack Start API route: GET/POST /oauth/authorize
//
// The user-facing OAuth authorization endpoint. Atproto OAuth is
// PAR-only: clients can't pass authorize parameters on the front channel,
// so the only useful query string here is `?request_uri=<urn:...>`. We
// look that up in `oauth_par`, render a login + consent screen, and on
// successful password verification mint a one-shot authorization code
// and 302 the browser back to the client's `redirect_uri`.
//
// Implementation notes:
//   - We return HTML built as a string template literal rather than rendering
//     a React component. The page is ~30 lines of markup with no client-side
//     state; reaching for React would add framework surface for no win.
//   - CSRF: on GET we set an HttpOnly cookie (`oauth_csrf=<random>`); the form
//     includes the same value in a hidden field; on POST we compare.
//   - On successful redeem we DELETE the PAR row so a refresh of the consent
//     screen can't replay it.
//
// See chapter 21 — OAuth.

import { createFileRoute } from '@tanstack/react-router'
import { and, eq, gt, lt } from 'drizzle-orm'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { db } from '~/lib/db'
import { oauthPar, type OauthParRow } from '~/lib/db/schema/oauth'
import { loginWithPassword } from '~/pds/auth/session'
import { signOauthCode } from '~/pds/oauth/tokens'

const CSRF_COOKIE = 'oauth_csrf'
const CSRF_COOKIE_MAX_AGE = 600 // 10 min — bounded by the 60s PAR TTL anyway

export const Route = createFileRoute('/oauth/authorize')({
  server: {
    handlers: {
      GET: async ({ request }) => handleGet(request),
      POST: async ({ request }) => handlePost(request),
    },
  },
})

// ─── GET: render the login + consent form ──────────────────────────────────

async function handleGet(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const requestUri = url.searchParams.get('request_uri')
  if (!requestUri) {
    return htmlErrorPage('Missing `request_uri` query parameter.', 400)
  }
  await cleanupExpiredPar()
  const par = await lookupPar(requestUri)
  if (!par) {
    return htmlErrorPage(
      'This authorization request has expired or is not recognised. The client must restart the flow.',
      400,
    )
  }
  const csrf = randomBytes(24).toString('base64url')
  const handlePrefill = par.loginHint ?? ''
  const body = renderLoginPage({
    par,
    csrf,
    handlePrefill,
    errorMessage: null,
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': csrfCookie(csrf),
    },
  })
}

// ─── POST: verify credentials, mint code, redirect to client ───────────────

async function handlePost(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const requestUri = url.searchParams.get('request_uri')
  if (!requestUri) {
    return htmlErrorPage('Missing `request_uri` query parameter.', 400)
  }
  const ct = (request.headers.get('content-type') ?? '').toLowerCase()
  if (!ct.includes('application/x-www-form-urlencoded')) {
    return htmlErrorPage('Form submission must be x-www-form-urlencoded.', 400)
  }
  const form = new URLSearchParams(await request.text())
  const handle = (form.get('handle') ?? '').trim()
  const password = form.get('password') ?? ''
  const csrfField = form.get('csrf') ?? ''
  const csrfCookieValue = readCookie(request, CSRF_COOKIE) ?? ''

  if (!csrfCookieValue || !constantTimeEquals(csrfField, csrfCookieValue)) {
    return htmlErrorPage(
      'CSRF check failed. Reload the consent page and try again.',
      400,
    )
  }

  await cleanupExpiredPar()
  const par = await lookupPar(requestUri)
  if (!par) {
    return htmlErrorPage(
      'This authorization request has expired or is not recognised. The client must restart the flow.',
      400,
    )
  }

  if (handle.length === 0 || password.length === 0) {
    return new Response(
      renderLoginPage({
        par,
        csrf: csrfCookieValue,
        handlePrefill: handle,
        errorMessage: 'Handle and password are required.',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  }

  let did: string
  try {
    const { account } = await loginWithPassword(handle, password)
    did = account.did
  } catch {
    // Generic message — same as createSession; don't leak whether the
    // account exists. Re-render the form with the (sanitised) handle
    // prefilled so the user only retypes the password.
    return new Response(
      renderLoginPage({
        par,
        csrf: csrfCookieValue,
        handlePrefill: handle,
        errorMessage: 'Invalid handle or password.',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  }

  // Mint code, delete the PAR row so it can't be replayed, redirect.
  const { code } = await signOauthCode({
    did,
    clientId: par.clientId,
    redirectUri: par.redirectUri,
    scope: par.scope,
    codeChallenge: par.codeChallenge,
    codeChallengeMethod: par.codeChallengeMethod,
    dpopJkt: par.dpopJkt,
  })
  await db.delete(oauthPar).where(eq(oauthPar.requestUri, requestUri))

  const redirect = new URL(par.redirectUri)
  redirect.searchParams.set('code', code)
  redirect.searchParams.set('state', par.state)
  // RFC 9207 — let the client confirm which AS issued the redirect.
  // The PAR row pinned the client_id; the issuer is this PDS's public URL.
  // We don't have getConfig() imported but the request's origin is correct
  // here (the user just hit /oauth/authorize on us).
  redirect.searchParams.set('iss', `${url.protocol}//${url.host}`)
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.toString(),
      // Clear the CSRF cookie — its single use is done.
      'set-cookie': `${CSRF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    },
  })
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function lookupPar(requestUri: string): Promise<OauthParRow | null> {
  const rows = await db
    .select()
    .from(oauthPar)
    .where(and(eq(oauthPar.requestUri, requestUri), gt(oauthPar.expiresAt, new Date())))
    .limit(1)
  return rows[0] ?? null
}

/** Best-effort sweep of expired PAR rows. Cheap; the table is tiny. */
async function cleanupExpiredPar(): Promise<void> {
  try {
    await db.delete(oauthPar).where(lt(oauthPar.expiresAt, new Date()))
  } catch {
    // Don't fail the request over cleanup — the index makes this cheap and
    // a transient error here doesn't affect correctness of the lookup.
  }
}

function csrfCookie(value: string): string {
  return `${CSRF_COOKIE}=${value}; Path=/; Max-Age=${CSRF_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    if (k === name) return part.slice(idx + 1).trim()
  }
  return null
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  if (a.length === 0) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

// ─── HTML rendering ────────────────────────────────────────────────────────

type RenderArgs = {
  par: OauthParRow
  csrf: string
  handlePrefill: string
  errorMessage: string | null
}

function renderLoginPage(args: RenderArgs): string {
  const { par, csrf, handlePrefill, errorMessage } = args
  const scopes = par.scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => `<code>${esc(s)}</code>`)
    .join(' ')
  const errorBlock = errorMessage
    ? `<p class="error" role="alert">${esc(errorMessage)}</p>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${esc(par.clientId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  .client { background: rgba(127,127,127,0.1); padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1.25rem; }
  .client code { word-break: break-all; }
  form { display: grid; gap: 0.75rem; }
  label { display: grid; gap: 0.25rem; font-weight: 500; }
  input { font: inherit; padding: 0.5rem 0.6rem; border: 1px solid rgba(127,127,127,0.4); border-radius: 4px; background: transparent; color: inherit; }
  button { font: inherit; padding: 0.55rem 1rem; border: 0; border-radius: 4px; background: #2868d8; color: white; cursor: pointer; }
  button:hover { background: #1f57bf; }
  .error { color: #c1392b; background: rgba(193,57,43,0.1); padding: 0.5rem 0.75rem; border-radius: 4px; margin: 0; }
  .muted { color: rgba(127,127,127,0.9); font-size: 0.875rem; }
</style>
</head>
<body>
<h1>Sign in to authorize this app</h1>
<div class="client">
  <strong>${esc(par.clientId)}</strong>
  wants to access your account with scope ${scopes || '<code>(none)</code>'}.
</div>
${errorBlock}
<form method="POST" action="/oauth/authorize?request_uri=${encodeURIComponent(par.requestUri)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}" />
  <label>Handle
    <input name="handle" type="text" autocomplete="username" required value="${esc(handlePrefill)}" />
  </label>
  <label>Password
    <input name="password" type="password" autocomplete="current-password" required />
  </label>
  <button type="submit">Authorize</button>
  <p class="muted">You'll be redirected back to <code>${esc(par.redirectUri)}</code>.</p>
</form>
</body>
</html>`
}

function htmlErrorPage(message: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>OAuth error</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  p { color: #c1392b; background: rgba(193,57,43,0.1); padding: 0.75rem 1rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>OAuth error</h1>
<p>${esc(message)}</p>
</body>
</html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
