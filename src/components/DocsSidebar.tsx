import { Link } from '@tanstack/react-router'
import type { ChapterSummary } from '~/lib/docs'

export function DocsSidebar({
  chapters,
  activeSlug,
}: {
  chapters: ChapterSummary[]
  activeSlug?: string
}) {
  return (
    <aside className="hidden md:block w-64 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)]/40">
      <nav className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto px-4 py-6">
        <p className="px-2 pb-3 text-xs font-mono uppercase tracking-widest text-[var(--color-fg-muted)]">
          Chapters
        </p>
        <ul className="space-y-1">
          {chapters.map((c) => {
            const isActive = c.slug === activeSlug
            return (
              <li key={c.slug}>
                <Link
                  to="/docs/$slug"
                  params={{ slug: c.slug }}
                  className={
                    'block rounded px-2 py-1.5 text-sm transition-colors ' +
                    (isActive
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]')
                  }
                >
                  <span className="font-mono text-xs text-[var(--color-fg-muted)] mr-2">
                    {String(c.number ?? 0).padStart(2, '0')}
                  </span>
                  {c.title}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}
