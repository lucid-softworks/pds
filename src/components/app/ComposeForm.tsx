import { useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { xrpcCall, XrpcError } from '~/lib/client/xrpc'
import { getSession } from '~/lib/client/session'
import {
  POST_MAX_BYTES,
  POST_MAX_GRAPHEMES,
  validatePostText,
} from '~/lib/client/postLimits'

// One-field "what's on your mind". POSTs an `app.bsky.feed.post` record via
// com.atproto.repo.createRecord and bounces to /app/feed on success.
//
// We compute the grapheme/byte counters every keystroke. For very long posts
// (thousands of chars) that's still micro-second work — `Intl.Segmenter` is
// fast — so we don't bother debouncing.

type CreateRecordResponse = { uri: string; cid: string }

export function ComposeForm() {
  const router = useRouter()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const validation = useMemo(() => validatePostText(text), [text])
  const overGraphemes = validation.graphemes > POST_MAX_GRAPHEMES
  const overBytes = validation.bytes > POST_MAX_BYTES

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!validation.ok) {
      setError(validation.reason)
      return
    }
    const session = getSession()
    if (!session) {
      setError('Not logged in.')
      return
    }
    setBusy(true)
    try {
      await xrpcCall<CreateRecordResponse>('com.atproto.repo.createRecord', {
        auth: true,
        input: {
          repo: session.did,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text,
            createdAt: new Date().toISOString(),
          },
        },
      })
      await router.navigate({ to: '/app/feed' })
      router.invalidate()
    } catch (err: unknown) {
      if (err instanceof XrpcError) {
        if (err.errorCode === 'ExpiredToken') {
          await router.navigate({ to: '/app' })
          router.invalidate()
          return
        }
        setError(err.message || 'Could not create post.')
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('Could not create post.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What's on your mind?"
        rows={6}
        className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]/60"
      />
      <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
        <span className="font-mono">
          <span className={overGraphemes ? 'text-red-400' : ''}>
            {validation.graphemes}
          </span>
          {' / '}
          {POST_MAX_GRAPHEMES} graphemes
          <span className="mx-2">·</span>
          <span className={overBytes ? 'text-red-400' : ''}>
            {validation.bytes}
          </span>
          {' / '}
          {POST_MAX_BYTES} bytes
        </span>
      </div>
      {error ? (
        <p className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy || !validation.ok}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-bg)] hover:bg-[var(--color-accent)]/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </form>
  )
}
