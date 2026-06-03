// HTML-rendering helpers for the /admin pages.
//
// We render with string templates (like /oauth/authorize) rather than React
// for two reasons: (1) the operator surface is form-driven, so React state
// adds no value; (2) it keeps the bundle invariant — the docs site, the
// /app client, and the admin pages each pick their own rendering style
// without dragging server-only DB code into the client tree.

import { getConfig } from '~/lib/config'

const NAV_ITEMS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/signups', label: 'Signups' },
  { href: '/admin/invites', label: 'Invite codes' },
]

export type AdminLayoutContext = {
  title: string
  body: string
  currentPath: string
  adminHandle: string
  flash?: { kind: 'ok' | 'error'; message: string } | null
}

export function renderAdminPage(ctx: AdminLayoutContext): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(ctx.title)} — Admin</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/admin">pds<span class="brand-sub">/admin</span></a>
  <nav class="navlinks">
    ${NAV_ITEMS.map((item) => navLink(item, ctx.currentPath)).join('')}
  </nav>
  <div class="who">
    signed in as <span class="who-handle">@${escape(ctx.adminHandle)}</span>
    <form action="/admin/logout" method="POST" class="inline-form">
      <button type="submit" class="link-button">log out</button>
    </form>
  </div>
</header>
<main class="container">
  ${ctx.flash ? flashBanner(ctx.flash) : ''}
  ${ctx.body}
</main>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function renderLoginPage(args: {
  errorMessage?: string
  csrfToken: string
  redirectTo: string | null
  csrfCookieHeader: string
}): Response {
  const cfg = getConfig()
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin login</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<main class="login-shell">
  <div class="login-card">
    <p class="kicker">${escape(cfg.hostname)}</p>
    <h1>Admin</h1>
    <p class="muted">
      Sign in as the account whose handle is configured in
      <code>PDS_ADMIN_HANDLE</code>.
    </p>
    ${args.errorMessage ? `<p class="error">${escape(args.errorMessage)}</p>` : ''}
    <form action="/admin/login" method="POST" class="form">
      <input type="hidden" name="csrf" value="${escape(args.csrfToken)}">
      ${args.redirectTo ? `<input type="hidden" name="redirect_to" value="${escape(args.redirectTo)}">` : ''}
      <label>
        <span>Handle</span>
        <input type="text" name="handle" autocomplete="username" required autofocus>
      </label>
      <label>
        <span>Password</span>
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit" class="primary">Sign in</button>
    </form>
  </div>
</main>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': args.csrfCookieHeader,
    },
  })
}

export function renderAdminDisabled(): Response {
  return new Response(
    `<!doctype html><html><head><title>Admin disabled</title><style>${INLINE_CSS}</style></head>
<body><main class="login-shell"><div class="login-card">
<h1>Admin disabled</h1>
<p class="muted">Set <code>PDS_ADMIN_HANDLE</code> in the server's environment
to point at the account that should gate the /admin UI, then restart.</p>
</div></main></body></html>`,
    {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  )
}

function navLink(
  item: { href: string; label: string },
  currentPath: string,
): string {
  const active =
    item.href === '/admin'
      ? currentPath === '/admin' || currentPath === '/admin/'
      : currentPath.startsWith(item.href)
  return `<a href="${item.href}" class="navlink${active ? ' navlink-active' : ''}">${escape(item.label)}</a>`
}

function flashBanner(flash: { kind: 'ok' | 'error'; message: string }): string {
  return `<div class="flash flash-${flash.kind}">${escape(flash.message)}</div>`
}

/** HTML-escape an untrusted string. */
export function escape(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const INLINE_CSS = `
:root {
  color-scheme: dark;
  --bg: #0b0d10;
  --surface: #15181d;
  --surface-2: #1c2026;
  --border: #2a2f37;
  --fg: #e6e8eb;
  --fg-muted: #9aa3ad;
  --accent: #7aa2f7;
  --accent-2: #bb9af7;
  --ok: #9ece6a;
  --err: #f7768e;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 'Inter', ui-sans-serif, system-ui, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: 12px ui-monospace, SFMono-Regular, monospace; background: var(--surface-2); padding: 0.1em 0.35em; border-radius: 3px; }

.topbar { display: flex; align-items: center; gap: 2rem; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--border); background: rgba(21, 24, 29, 0.6); backdrop-filter: blur(4px); position: sticky; top: 0; z-index: 10; }
.brand { font: 13px ui-monospace, monospace; color: var(--accent); text-decoration: none; }
.brand-sub { color: var(--fg-muted); }
.navlinks { display: flex; gap: 1.5rem; flex: 1; }
.navlink { color: var(--fg-muted); font-size: 13px; padding: 0.25rem 0; border-bottom: 2px solid transparent; }
.navlink:hover { color: var(--fg); text-decoration: none; }
.navlink-active { color: var(--fg); border-bottom-color: var(--accent); }
.who { font-size: 12px; color: var(--fg-muted); display: flex; align-items: center; gap: 0.75rem; }
.who-handle { font-family: ui-monospace, monospace; color: var(--fg); }
.inline-form { display: inline; }
.link-button { background: none; border: none; color: var(--fg-muted); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
.link-button:hover { color: var(--fg); }

.container { max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

h1 { font-size: 1.5rem; margin: 0 0 0.25rem; font-weight: 600; letter-spacing: -0.01em; }
h2 { font-size: 1rem; margin: 2rem 0 0.75rem; font-weight: 600; letter-spacing: -0.005em; }
.kicker { font: 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.15em; color: var(--accent-2); margin: 0; }
.muted { color: var(--fg-muted); margin: 0.5rem 0 1rem; }

.flash { border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem; margin-bottom: 1.5rem; }
.flash-ok { border-color: rgba(158, 206, 106, 0.4); background: rgba(158, 206, 106, 0.08); color: var(--ok); }
.flash-error { border-color: rgba(247, 118, 142, 0.4); background: rgba(247, 118, 142, 0.08); color: var(--err); }
.error { color: var(--err); margin: 0.5rem 0; }

.grid { display: grid; gap: 1rem; }
.grid-2 { grid-template-columns: repeat(2, 1fr); }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 720px) { .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; } }

.card { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 1rem 1.25rem; }
.card h2 { margin-top: 0; }
.stat-label { font: 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.15em; color: var(--fg-muted); }
.stat-value { font-size: 2rem; font-weight: 600; margin-top: 0.25rem; font-variant-numeric: tabular-nums; }
.stat-sub { font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
th { font: 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted); font-weight: 500; }
tr:hover td { background: var(--surface-2); }
td.mono { font-family: ui-monospace, monospace; font-size: 12px; }
td.num { font-variant-numeric: tabular-nums; text-align: right; }

.pill { display: inline-block; font: 11px ui-monospace, monospace; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--fg-muted); }
.pill-ok { color: var(--accent); border-color: rgba(122, 162, 247, 0.4); background: rgba(122, 162, 247, 0.08); }
.pill-warn { color: #e0af68; border-color: rgba(224, 175, 104, 0.4); background: rgba(224, 175, 104, 0.08); }
.pill-err { color: var(--err); border-color: rgba(247, 118, 142, 0.4); background: rgba(247, 118, 142, 0.08); }

.form { display: grid; gap: 0.75rem; max-width: 360px; margin-top: 0.5rem; }
.form label { display: grid; gap: 0.25rem; }
.form label span { font: 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted); }
.form input, .form select { background: var(--surface); border: 1px solid var(--border); color: var(--fg); padding: 0.5rem 0.6rem; border-radius: 6px; font: inherit; }
.form input:focus, .form select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.primary { background: var(--accent); color: var(--bg); border: none; padding: 0.55rem 1rem; border-radius: 6px; font-weight: 600; cursor: pointer; }
.primary:hover { opacity: 0.9; }
.danger { background: transparent; color: var(--err); border: 1px solid rgba(247, 118, 142, 0.4); padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 12px; cursor: pointer; }
.danger:hover { background: rgba(247, 118, 142, 0.1); }
.secondary { background: var(--surface); color: var(--fg); border: 1px solid var(--border); padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 12px; cursor: pointer; }
.secondary:hover { background: var(--surface-2); }

.login-shell { min-height: 100vh; display: grid; place-items: center; padding: 2rem; }
.login-card { width: 100%; max-width: 360px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 2rem; }
.login-card h1 { margin: 0.5rem 0 0.25rem; }
`
