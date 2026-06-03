// Double-submit CSRF tokens for the /admin web UI.
//
// Pattern: GET pages set a random token in a non-HttpOnly cookie AND embed
// the same value in a hidden form field. POST handlers verify the field
// matches the cookie. A cross-site form post can't read the cookie, so it
// can't forge the matching field — even though the browser will happily
// attach the session cookie to the cross-site POST.
//
// 32 bytes from `node:crypto.randomBytes` is plenty.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ADMIN_CSRF_COOKIE, cookieHeader, readCookie } from './auth'

export function mintCsrfToken(): { token: string; setCookieHeader: string } {
  const token = randomBytes(32).toString('hex')
  return {
    token,
    setCookieHeader: cookieHeader(ADMIN_CSRF_COOKIE, token, {
      // Readable by GET handlers + JS-visible — that's the *point* of
      // double-submit; the form picks the value back up from this cookie.
      // We still scope it to /admin so it doesn't leak to other paths.
      httpOnly: false,
      sameSite: 'Strict',
      path: '/admin',
      maxAge: 60 * 60,
    }),
  }
}

export function verifyCsrf(request: Request, formValue: string | null): boolean {
  if (!formValue) return false
  const cookieValue = readCookie(request, ADMIN_CSRF_COOKIE)
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
