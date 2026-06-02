import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { listChapters, type ChapterSummary } from '~/lib/docs'
import { DocsSidebar } from '~/components/DocsSidebar'

const getChapters = createServerFn({ method: 'GET' }).handler(async () => {
  return listChapters()
})

export const Route = createFileRoute('/docs/')({
  loader: () => getChapters(),
  component: DocsIndex,
})

function DocsIndex() {
  const chapters = Route.useLoaderData()
  return (
    <div className="mx-auto flex max-w-6xl">
      <DocsSidebar chapters={chapters} />
      <main className="flex-1 px-6 py-10 md:px-12">
        <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-accent-2)]">
          The book
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
          How to build your own PDS
        </h1>
        <p className="mt-4 max-w-2xl text-[var(--color-fg-muted)]">
          A chapter per subsystem, in reading order. The code that each chapter
          discusses lives in{' '}
          <code className="font-mono text-xs bg-[var(--color-surface)] px-1.5 py-0.5 rounded">
            src/pds/
          </code>
          ; jump between the two as you go.
        </p>
        <ol className="mt-10 space-y-2">
          {chapters.map((c: ChapterSummary) => (
            <li key={c.slug}>
              <Link
                to="/docs/$slug"
                params={{ slug: c.slug }}
                className="group block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-accent)]/60 transition-colors"
              >
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                    Chapter {String(c.number ?? 0).padStart(2, '0')}
                  </span>
                  <h3 className="text-base font-medium group-hover:text-[var(--color-accent)] transition-colors">
                    {c.title}
                  </h3>
                </div>
                {c.blurb ? (
                  <p className="mt-1.5 text-sm text-[var(--color-fg-muted)] line-clamp-2">
                    {c.blurb}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ol>
      </main>
    </div>
  )
}
