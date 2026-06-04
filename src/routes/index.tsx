import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { formatBytes, formatCount, formatDuration, type PdsStats } from '~/lib/stats'

// `~/lib/stats.server` imports `~/lib/db` → postgres-js, which doesn't
// browser-bundle. Dynamic-import inside the handler so it stays out of the
// client tree.
const loadStats = createServerFn({ method: 'GET' }).handler(async () => {
  const { getPdsStats } = await import('~/lib/stats.server')
  return await getPdsStats()
})

export const Route = createFileRoute('/')({
  loader: () => loadStats(),
  component: HomePage,
})

function HomePage() {
  const stats = Route.useLoaderData()

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header>
        <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-accent-2)]">
          Personal data server
        </p>
        <h1 className="mt-3 font-mono text-3xl font-semibold tracking-tight md:text-4xl">
          {stats.service.hostname}
        </h1>
        <p className="mt-2 font-mono text-sm text-[var(--color-fg-muted)] break-all">
          {stats.service.did}
        </p>
        <p className="mt-1 font-mono text-sm text-[var(--color-fg-muted)] break-all">
          {stats.service.publicUrl}
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Pill on={!stats.service.localPlcOnly}>
            {stats.service.localPlcOnly ? 'local PLC' : 'plc.directory'}
          </Pill>
          <Pill on={!stats.service.inviteRequired} muted>
            {stats.service.inviteRequired ? 'invite-only' : 'open signup'}
          </Pill>
        </div>
      </header>

      <section className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Accounts" value={formatCount(stats.accounts.active)} sub={`${formatCount(stats.accounts.total)} total`}>
          <Breakdown
            items={[
              ['active', stats.accounts.active],
              ['deactivated', stats.accounts.deactivated],
              ['takendown', stats.accounts.takendown],
              ['deleted', stats.accounts.deleted],
            ]}
          />
        </StatCard>

        <StatCard label="Records" value={formatCount(stats.content.records)} sub={`across ${formatCount(stats.content.repos)} repos`} />

        <StatCard
          label="Blobs"
          value={formatCount(stats.content.blobs.count)}
          sub={formatBytes(stats.content.blobs.bytes)}
        />

        <StatCard
          label="Firehose"
          value={formatCount(stats.firehose.latestSeq)}
          sub="latest seq"
        >
          <Breakdown
            items={[
              ['#commit', stats.firehose.eventCounts.commit],
              ['#identity', stats.firehose.eventCounts.identity],
              ['#account', stats.firehose.eventCounts.account],
              ['#tombstone', stats.firehose.eventCounts.tombstone],
            ]}
          />
        </StatCard>

        <StatCard
          label="Host"
          value={stats.host.loadavg[0].toFixed(2)}
          sub={`load · ${stats.host.cpus} CPU${stats.host.cpus !== 1 ? 's' : ''} · up ${formatDuration(stats.host.uptime)}`}
        >
          <dl className="space-y-1 text-xs font-mono">
            <div className="flex justify-between">
              <dt className="text-[var(--color-fg-muted)]">memory</dt>
              <dd className="tabular-nums">{formatBytes(stats.host.memory.used)} / {formatBytes(stats.host.memory.total)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--color-fg-muted)]">process</dt>
              <dd className="tabular-nums">{formatBytes(stats.host.processRss)} rss</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--color-fg-muted)]">load 5/15m</dt>
              <dd className="tabular-nums">{stats.host.loadavg[1].toFixed(2)} / {stats.host.loadavg[2].toFixed(2)}</dd>
            </div>
          </dl>
        </StatCard>
      </section>

      <section className="mt-12 grid gap-4 md:grid-cols-2">
        <LinkCard title="Read the docs" href="/docs" internal>
          Chapter-per-subsystem book walking the codebase from CIDs to OAuth.
        </LinkCard>
        <LinkCard title="Open the client" href="/app" internal>
          Log in, see your feed, write a post. Talks to this PDS via XRPC.
        </LinkCard>
        <LinkCard title="Service DID document" href="/.well-known/did.json">
          The did:web identity document this PDS publishes for itself.
        </LinkCard>
        <LinkCard title="Server description" href="/xrpc/com.atproto.server.describeServer">
          com.atproto.server.describeServer — capabilities, available handle domains, contact.
        </LinkCard>
        <LinkCard title="OAuth metadata" href="/.well-known/oauth-authorization-server">
          RFC 8414 metadata for the authorization-server role this PDS plays.
        </LinkCard>
        <LinkCard title="Firehose" href="/xrpc/com.atproto.sync.subscribeRepos">
          WebSocket subscribeRepos. Connect with <code className="font-mono text-xs bg-[var(--color-surface-2)] px-1 py-0.5 rounded">wscat -c</code>.
        </LinkCard>
        <LinkCard title="Operator console" href="/admin" hardNav>
          Dashboard for signups and invite codes. Gated by{' '}
          <code className="font-mono text-xs bg-[var(--color-surface-2)] px-1 py-0.5 rounded">PDS_ADMIN_HANDLE</code>.
        </LinkCard>
      </section>

      <footer className="mt-16 border-t border-[var(--color-border)] pt-6 text-sm text-[var(--color-fg-muted)]">
        Built from the{' '}
        <a
          href="https://github.com/bluesky-social/pds"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-accent)] underline-offset-4 hover:underline"
        >
          Bluesky PDS
        </a>{' '}
        teaching port — <Link to="/docs" className="text-[var(--color-accent)] underline-offset-4 hover:underline">/docs</Link> for the book that pairs with the code.
      </footer>
    </main>
  )
}

function StatCard({
  label,
  value,
  sub,
  children,
}: {
  label: string
  value: string
  sub?: string
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-fg-muted)]">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub ? (
        <p className="mt-1 text-xs text-[var(--color-fg-muted)] tabular-nums">{sub}</p>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  )
}

function Breakdown({ items }: { items: Array<[string, number]> }) {
  return (
    <dl className="space-y-1 text-xs font-mono">
      {items.map(([label, n]) => (
        <div key={label} className="flex justify-between">
          <dt className="text-[var(--color-fg-muted)]">{label}</dt>
          <dd className="tabular-nums">{formatCount(n)}</dd>
        </div>
      ))}
    </dl>
  )
}

function Pill({
  children,
  on,
  muted,
}: {
  children: React.ReactNode
  on: boolean
  muted?: boolean
}) {
  const color = muted
    ? 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]'
    : on
      ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
      : 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]'
  return (
    <span className={`rounded border px-2 py-0.5 font-mono ${color}`}>{children}</span>
  )
}

function LinkCard({
  title,
  href,
  children,
  internal,
  hardNav,
}: {
  title: string
  href: string
  children: React.ReactNode
  /** Use TanStack Router's client-side nav (intra-SPA, with prefetch). */
  internal?: boolean
  /** Force a full page navigation even on same-origin URLs. Use for
   *  routes that don't participate in the React SPA — e.g. `/admin/*`
   *  which is server-rendered HTML with no client hydration. Without
   *  this, a stale React tree from this page can try to hydrate the
   *  admin response and crash with #418. */
  hardNav?: boolean
}) {
  const className =
    'group block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-accent)]/60 transition-colors'
  const Inner = (
    <>
      <p className="text-sm font-medium group-hover:text-[var(--color-accent)] transition-colors">
        {title} <span aria-hidden>→</span>
      </p>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{children}</p>
    </>
  )
  if (internal) {
    return (
      <Link to={href} className={className}>
        {Inner}
      </Link>
    )
  }
  if (hardNav) {
    return (
      <a
        href={href}
        className={className}
        onClick={(e) => {
          e.preventDefault()
          window.location.assign(href)
        }}
      >
        {Inner}
      </a>
    )
  }
  return (
    <a href={href} className={className}>
      {Inner}
    </a>
  )
}

// `PdsStats` shows up in the loader's return type via inference; keeping the
// type import live prevents accidental drift if the shape ever changes.
export type _PdsStats = PdsStats
