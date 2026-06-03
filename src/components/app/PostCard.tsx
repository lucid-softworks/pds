import { relativeTime } from '~/lib/client/relativeTime'

// One row in /app/feed. Renders:
//   - the post text (whitespace-preserved so newlines from the textarea
//     survive — but no rich-text facet rendering, that's an AppView concern),
//   - a relative-time stamp,
//   - the at:// URI in a selectable <code> block.
//
// We deliberately don't try to link the URI anywhere yet. The PDS has no
// canonical "view a single post" page — that would require a getRecord-shaped
// route on this client, which the chapter calls out as a follow-up.

export type PostRecord = {
  uri: string
  cid: string
  value: {
    $type?: string
    text?: string
    createdAt?: string
  }
}

export function PostCard({ post }: { post: PostRecord }) {
  const text = post.value.text ?? ''
  const createdAt = post.value.createdAt
  return (
    <article className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="whitespace-pre-wrap break-words text-[var(--color-fg)]">
        {text || (
          <span className="italic text-[var(--color-fg-muted)]">(empty post)</span>
        )}
      </p>
      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-fg-muted)]">
        <time
          dateTime={createdAt ?? ''}
          title={createdAt ?? 'unknown'}
        >
          {createdAt ? relativeTime(createdAt) : 'unknown time'}
        </time>
        <code className="font-mono text-[var(--color-fg-muted)] select-all break-all">
          {post.uri}
        </code>
      </footer>
    </article>
  )
}
