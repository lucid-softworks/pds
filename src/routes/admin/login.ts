// GET /admin/login — render the login form.
// POST /admin/login — validate handle + password + CSRF, set the
// admin-session cookie, redirect to ?redirect_to (sanitized).
//
// Auth model: the page is gated by the env var PDS_ADMIN_HANDLE. The
// operator logs in as that account through this form — the password
// check goes through the same loginWithPassword the regular session
// endpoint uses, so app passwords work here too.

import { createFileRoute } from '@tanstack/react-router'
import { getConfig } from '~/lib/config'
import { loginWithPassword } from '~/pds/auth/session'
import {
  signAdminSessionCookie,
  adminSessionCookieHeader,
  readCookie,
  ADMIN_CSRF_COOKIE,
} from '~/lib/admin-ui/auth'
import { mintCsrfToken, verifyCsrf } from '~/lib/admin-ui/csrf'
import { renderAdminDisabled, renderLoginPage } from '~/lib/admin-ui/render'

export const Route = createFileRoute('/admin/login')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cfg = getConfig()
        if (!cfg.adminHandle) return renderAdminDisabled()
        const url = new URL(request.url)
        const redirectTo = sanitizeRedirect(url.searchParams.get('redirect_to'))
        const existingCsrf = readCookie(request, ADMIN_CSRF_COOKIE)
        const { token, setCookieHeader } = existingCsrf
          ? { token: existingCsrf, setCookieHeader: '' }
          : mintCsrfToken()
        const res = renderLoginPage({
          csrfToken: token,
          redirectTo,
          csrfCookieHeader: setCookieHeader,
        })
        if (!setCookieHeader) res.headers.delete('set-cookie')
        return res
      },
      POST: async ({ request }) => {
        const cfg = getConfig()
        if (!cfg.adminHandle) return renderAdminDisabled()
        const form = await request.formData()
        const handle = String(form.get('handle') ?? '').trim().toLowerCase()
        const password = String(form.get('password') ?? '')
        const csrf = form.get('csrf')
        if (typeof csrf !== 'string' || !verifyCsrf(request, csrf)) {
          return renderLoginRedirectWithError(
            request,
            'session expired, try again',
          )
        }
        if (handle !== cfg.adminHandle) {
          // Same generic error so we don't disclose whether the handle
          // matched the admin or merely an unrelated account.
          return renderLoginRedirectWithError(request, 'invalid credentials')
        }
        try {
          const { account } = await loginWithPassword(handle, password)
          if (account.handle !== cfg.adminHandle) {
            return renderLoginRedirectWithError(request, 'invalid credentials')
          }
          if (account.status !== 'active') {
            return renderLoginRedirectWithError(request, 'account not active')
          }
          const { jwt, expiresAt } = await signAdminSessionCookie({
            did: account.did,
            handle: account.handle,
          })
          const url = new URL(request.url)
          const redirectTo =
            sanitizeRedirect(String(form.get('redirect_to') ?? '')) ?? '/admin'
          return new Response(null, {
            status: 303,
            headers: {
              location: redirectTo,
              'set-cookie': adminSessionCookieHeader(jwt, expiresAt),
            },
          })
        } catch {
          return renderLoginRedirectWithError(request, 'invalid credentials')
        }
      },
    },
  },
})

function renderLoginRedirectWithError(
  request: Request,
  message: string,
): Response {
  const existingCsrf = readCookie(request, ADMIN_CSRF_COOKIE)
  const { token, setCookieHeader } = existingCsrf
    ? { token: existingCsrf, setCookieHeader: '' }
    : mintCsrfToken()
  const url = new URL(request.url)
  const redirectTo = sanitizeRedirect(
    url.searchParams.get('redirect_to') ?? null,
  )
  const res = renderLoginPage({
    errorMessage: message,
    csrfToken: token,
    redirectTo,
    csrfCookieHeader: setCookieHeader,
  })
  if (!setCookieHeader) res.headers.delete('set-cookie')
  return new Response(res.body, { status: 401, headers: res.headers })
}

/** Only allow redirects to /admin/... — anything else falls back to the
 *  dashboard. Prevents an open-redirect via the ?redirect_to query. */
function sanitizeRedirect(target: string | null): string | null {
  if (!target) return null
  if (!target.startsWith('/admin')) return null
  if (target.includes('//')) return null
  return target
}
