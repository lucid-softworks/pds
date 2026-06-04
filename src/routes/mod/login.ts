// GET /mod/login — render the login form.
// POST /mod/login — validate handle + password + CSRF; check the
// resulting DID is in `mod_team`; set the mod-session cookie; redirect.

import { createFileRoute } from '@tanstack/react-router'
import { loginWithPassword } from '~/pds/auth/session'
import { isModerator } from '~/pds/mod/team'
import {
  signModSessionCookie,
  modSessionCookieHeader,
  MOD_CSRF_COOKIE,
} from '~/lib/mod-ui/auth'
import { readCookie } from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/mod-ui/csrf'
import {
  renderModLoginPage,
  renderModNotProvisioned,
} from '~/lib/mod-ui/render'
import { getModTeamLead } from '~/pds/mod/team'

export const Route = createFileRoute('/mod/login')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const url = new URL(request.url)
        const redirectTo = sanitizeRedirect(url.searchParams.get('redirect_to'))
        const existingCsrf = readCookie(request, MOD_CSRF_COOKIE)
        const { token, setCookieHeader } = existingCsrf
          ? { token: existingCsrf, setCookieHeader: '' }
          : mintCsrfToken()
        const res = renderModLoginPage({
          csrfToken: token,
          redirectTo,
          csrfCookieHeader: setCookieHeader,
        })
        if (!setCookieHeader) res.headers.delete('set-cookie')
        return res
      },
      POST: async ({ request }) => {
        if ((await getModTeamLead()) === null) return renderModNotProvisioned()
        const form = await request.formData()
        const handle = String(form.get('handle') ?? '').trim().toLowerCase()
        const password = String(form.get('password') ?? '')
        const csrf = form.get('csrf')
        if (typeof csrf !== 'string' || !verifyCsrf(request, csrf)) {
          return loginErr(request, 'session expired, try again')
        }
        try {
          const { account } = await loginWithPassword(handle, password)
          if (account.status !== 'active') {
            return loginErr(request, 'account not active')
          }
          if (!(await isModerator(account.did))) {
            // Same generic message — we don't disclose whether the
            // password matched. (A successful password for a non-mod
            // account still lands here.)
            return loginErr(request, 'invalid credentials')
          }
          const { jwt, expiresAt } = await signModSessionCookie({
            did: account.did,
            handle: account.handle,
          })
          const redirectTo =
            sanitizeRedirect(String(form.get('redirect_to') ?? '')) ?? '/mod'
          return new Response(null, {
            status: 303,
            headers: {
              location: redirectTo,
              'set-cookie': modSessionCookieHeader(jwt, expiresAt),
            },
          })
        } catch {
          return loginErr(request, 'invalid credentials')
        }
      },
    },
  },
})

function loginErr(request: Request, message: string): Response {
  const existingCsrf = readCookie(request, MOD_CSRF_COOKIE)
  const { token, setCookieHeader } = existingCsrf
    ? { token: existingCsrf, setCookieHeader: '' }
    : mintCsrfToken()
  const url = new URL(request.url)
  const redirectTo = sanitizeRedirect(url.searchParams.get('redirect_to') ?? null)
  const res = renderModLoginPage({
    errorMessage: message,
    csrfToken: token,
    redirectTo,
    csrfCookieHeader: setCookieHeader,
  })
  if (!setCookieHeader) res.headers.delete('set-cookie')
  return new Response(res.body, { status: 401, headers: res.headers })
}

function sanitizeRedirect(target: string | null): string | null {
  if (!target) return null
  if (!target.startsWith('/mod')) return null
  if (target.includes('//')) return null
  return target
}
