import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-accent-2)]">
        A teaching reimplementation
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
        Build your own Bluesky PDS, one chapter at a time.
      </h1>
      <p className="mt-6 text-lg leading-relaxed text-[var(--color-fg-muted)]">
        This project is a from-scratch port of{' '}
        <a
          href="https://github.com/bluesky-social/pds"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-accent)] underline-offset-4 hover:underline"
        >
          bluesky-social/pds
        </a>{' '}
        written in TanStack Start. Every subsystem — DIDs, Merkle Search
        Trees, CAR files, lexicons, XRPC, the firehose — comes with a numbered
        tutorial chapter that walks through the code you can run locally.
      </p>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          to="/docs"
          className="rounded-md bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-[var(--color-bg)] hover:bg-[var(--color-accent)]/90 transition-colors"
        >
          Start reading →
        </Link>
        <a
          href="https://atproto.com/specs/atp"
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-2)] transition-colors"
        >
          AT Protocol spec
        </a>
      </div>

      <section className="mt-16 grid gap-4 md:grid-cols-2">
        <Card title="Faithful, not faked">
          The code actually implements the protocol — CIDs, MST commits, CAR
          export, signed JWTs. We use battle-tested IPLD libraries for format
          plumbing but hand-roll everything AT Protocol-specific so you can
          read it.
        </Card>
        <Card title="Postgres everywhere">
          Dev uses an in-process Postgres via WASM (
          <code className="font-mono text-xs">@electric-sql/pglite</code>).
          Prod points at any hosted Postgres. Same SQL, same Drizzle schema.
        </Card>
        <Card title="One repo, one mental model">
          The docs are a route in the same app. The schema, the XRPC handlers,
          and the chapter explaining them all live next to each other so it's
          easy to jump back and forth.
        </Card>
        <Card title="Long-form, on purpose">
          A PDS spans roughly a hundred XRPC endpoints, identity resolution,
          repo storage, blob storage, and a streaming firehose. The docs take
          their time so the design decisions stay legible.
        </Card>
      </section>
    </main>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-fg-muted)]">
        {children}
      </p>
    </div>
  )
}
