// HTML-rendering helpers for the /mod pages. Mirrors
// `src/lib/admin-ui/render.ts` so the two operator surfaces look like
// siblings — the only thing different is the nav + the "signed in as"
// pill format.

import { getConfig } from '~/lib/config'
import { escape } from '~/lib/admin-ui/render'

const NAV_ITEMS = [
  { href: '/mod', label: 'Dashboard' },
  { href: '/mod/events', label: 'Events' },
  { href: '/mod/labels', label: 'Labels' },
  { href: '/mod/team', label: 'Team' },
]

export { escape }

export type ModLayoutContext = {
  title: string
  body: string
  currentPath: string
  signedInAs: { handle: string; role: 'lead' | 'moderator' | 'admin' }
  flash?: { kind: 'ok' | 'error'; message: string } | null
}

export function renderModPage(ctx: ModLayoutContext): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(ctx.title)} — Mod</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/mod">pds<span class="brand-sub">/mod</span></a>
  <nav class="navlinks">
    ${NAV_ITEMS.map((item) => navLink(item, ctx.currentPath)).join('')}
  </nav>
  <div class="who">
    ${signedInAs(ctx.signedInAs)}
    ${ctx.signedInAs.role === 'admin'
      ? ''
      : `<form action="/mod/logout" method="POST" class="inline-form">
           <button type="submit" class="link-button">log out</button>
         </form>`}
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

export function renderModLoginPage(args: {
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
<title>Mod login</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<main class="login-shell">
  <div class="login-card">
    <p class="kicker">${escape(cfg.hostname)}</p>
    <h1>Moderation</h1>
    <p class="muted">
      Sign in as an account whose DID is on the moderation team. The
      team lead is the account whose handle matches
      <code>${escape(cfg.modTeamHandle)}</code>.
    </p>
    ${args.errorMessage ? `<p class="error">${escape(args.errorMessage)}</p>` : ''}
    <form action="/mod/login" method="POST" class="form">
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

export function renderModNotProvisioned(): Response {
  return new Response(
    `<!doctype html><html><head><title>Moderation unavailable</title><style>${INLINE_CSS}</style></head>
<body><main class="login-shell"><div class="login-card">
<h1>Moderation team not provisioned</h1>
<p class="muted">
  No account on this PDS yet matches <code>${escape(getConfig().modTeamHandle)}</code>.
  Create that account through the normal signup flow (or change
  <code>PDS_MOD_TEAM_HANDLE</code> to point at an existing account)
  and reload.
</p>
</div></main></body></html>`,
    {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  )
}

function navLink(
  item: { href: string; label: string },
  currentPath: string,
): string {
  const active =
    item.href === '/mod'
      ? currentPath === '/mod' || currentPath === '/mod/'
      : currentPath.startsWith(item.href)
  return `<a href="${item.href}" class="navlink${active ? ' navlink-active' : ''}">${escape(item.label)}</a>`
}

function signedInAs(s: { handle: string; role: string }): string {
  if (s.role === 'admin') {
    return `<span class="who-role">admin (Basic)</span>`
  }
  return `signed in as <span class="who-handle">@${escape(s.handle)}</span> <span class="who-role">${escape(s.role)}</span>`
}

function flashBanner(flash: { kind: 'ok' | 'error'; message: string }): string {
  return `<div class="flash flash-${flash.kind}">${escape(flash.message)}</div>`
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
  --accent: #bb9af7;
  --accent-2: #f7768e;
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
.who-role { font-family: ui-monospace, monospace; color: var(--accent); border: 1px solid var(--border); border-radius: 3px; padding: 0 0.4rem; }
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
.pill-ok { color: var(--accent); border-color: rgba(187, 154, 247, 0.4); background: rgba(187, 154, 247, 0.08); }
.pill-warn { color: #e0af68; border-color: rgba(224, 175, 104, 0.4); background: rgba(224, 175, 104, 0.08); }
.pill-err { color: var(--err); border-color: rgba(247, 118, 142, 0.4); background: rgba(247, 118, 142, 0.08); }

.form { display: grid; gap: 0.75rem; max-width: 480px; margin-top: 0.5rem; }
.form label { display: grid; gap: 0.25rem; }
.form label span { font: 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted); }
.form input, .form select, .form textarea { background: var(--surface); border: 1px solid var(--border); color: var(--fg); padding: 0.5rem 0.6rem; border-radius: 6px; font: inherit; font-family: inherit; }
.form input:focus, .form select:focus, .form textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.primary { background: var(--accent); color: var(--bg); border: none; padding: 0.55rem 1rem; border-radius: 6px; font-weight: 600; cursor: pointer; }
.primary:hover { opacity: 0.9; }
.danger { background: transparent; color: var(--err); border: 1px solid rgba(247, 118, 142, 0.4); padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 13px; cursor: pointer; font-weight: 600; }
.danger:hover { background: rgba(247, 118, 142, 0.1); }
.secondary { background: var(--surface); color: var(--fg); border: 1px solid var(--border); padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 13px; cursor: pointer; }
.secondary:hover { background: var(--surface-2); }

.action-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; }

.login-shell { min-height: 100vh; display: grid; place-items: center; padding: 2rem; }
.login-card { width: 100%; max-width: 360px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 2rem; }
.login-card h1 { margin: 0.5rem 0 0.25rem; }
`
