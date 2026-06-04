// Double-submit CSRF tokens for the /mod web UI. Same shape as
// `src/lib/admin-ui/csrf.ts` — the only difference is which cookie name
// scope is involved.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { cookieHeader, readCookie } from '~/lib/admin-ui/auth'
import { MOD_CSRF_COOKIE } from './auth'

export function mintCsrfToken(): { token: string; setCookieHeader: string } {
  const token = randomBytes(32).toString('hex')
  return {
    token,
    setCookieHeader: cookieHeader(MOD_CSRF_COOKIE, token, {
      httpOnly: false,
      sameSite: 'Strict',
      path: '/mod',
      maxAge: 60 * 60,
    }),
  }
}

export function verifyCsrf(request: Request, formValue: string | null): boolean {
  if (!formValue) return false
  const cookieValue = readCookie(request, MOD_CSRF_COOKIE)
  if (!cookieValue) return false
  if (cookieValue.length !== formValue.length) return false
  try {
    return timingSafeEqual(
      Buffer.from(cookieValue, 'utf8'),
      Buffer.from(formValue, 'utf8'),
    )
  } catch {
    return false
  }
}
