// Browser-side session storage for the in-repo Bluesky client at /app.
//
// We deliberately use the *legacy* createSession / refreshSession JWT flow
// rather than OAuth here: the client talks to its own PDS, same-origin, and
// the tutorial chapter 22 makes the teaching argument explicit. OAuth is
// chapter 21's concern and a separate front-end story.
//
// Storage: `localStorage` keyed at `pds.session`. The access JWT is readable
// by JS already (we issue it as a Bearer header), so localStorage isn't a
// security downgrade vs. an httpOnly cookie. It also keeps the example
// dependency-free — no cookie helper, no SSR session reads.

export type Session = {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
}

const KEY = 'pds.session'

// SSR guard. The TanStack Start router can call into modules that import this
// file at render time; `window` is undefined on the server.
function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

export function getSession(): Session | null {
  if (!hasStorage()) return null
  const raw = window.localStorage.getItem(KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Session>
    if (
      typeof parsed.did === 'string' &&
      typeof parsed.handle === 'string' &&
      typeof parsed.accessJwt === 'string' &&
      typeof parsed.refreshJwt === 'string'
    ) {
      return {
        did: parsed.did,
        handle: parsed.handle,
        accessJwt: parsed.accessJwt,
        refreshJwt: parsed.refreshJwt,
      }
    }
    return null
  } catch {
    return null
  }
}

export function setSession(s: Session): void {
  if (!hasStorage()) return
  window.localStorage.setItem(KEY, JSON.stringify(s))
}

export function clearSession(): void {
  if (!hasStorage()) return
  window.localStorage.removeItem(KEY)
}

// Sugar around clearSession that also revokes the refresh token server-side
// when one is present. Idempotent: a 401 here just means the token was
// already expired/revoked, which is fine.
export async function logout(): Promise<void> {
  const s = getSession()
  clearSession()
  if (!s) return
  try {
    await fetch('/xrpc/com.atproto.server.deleteSession', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.refreshJwt}` },
    })
  } catch {
    // network errors on logout are non-fatal — the local state is gone.
  }
}
