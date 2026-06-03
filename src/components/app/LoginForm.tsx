import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { xrpcCall, XrpcError } from '~/lib/client/xrpc'
import { setSession } from '~/lib/client/session'

// Handle/DID/email + password → access + refresh JWT pair. We don't render
// the email field on first sign-in (createAccount is its own concern); this
// form only logs in.
//
// The createSession lexicon accepts either a handle, a DID, or an email in
// `identifier`. We label it "handle" because that's what 95% of users will
// type; the server doesn't actually care about the surface form.

type CreateSessionResponse = {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
}

export function LoginForm() {
  const router = useRouter()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await xrpcCall<CreateSessionResponse>(
        'com.atproto.server.createSession',
        { input: { identifier: identifier.trim(), password } },
      )
      setSession({
        did: res.did,
        handle: res.handle,
        accessJwt: res.accessJwt,
        refreshJwt: res.refreshJwt,
      })
      await router.navigate({ to: '/app/feed' })
      router.invalidate()
    } catch (err: unknown) {
      if (err instanceof XrpcError) {
        setError(err.message || 'Login failed.')
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('Login failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 space-y-4">
      <div>
        <label
          htmlFor="identifier"
          className="block text-xs uppercase tracking-widest text-[var(--color-fg-muted)]"
        >
          Handle or email
        </label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="alice.example.com"
          className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono outline-none focus:border-[var(--color-accent)]/60"
        />
      </div>
      <div>
        <label
          htmlFor="password"
          className="block text-xs uppercase tracking-widest text-[var(--color-fg-muted)]"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]/60"
        />
      </div>
      {error ? (
        <p className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-bg)] hover:bg-[var(--color-accent)]/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
