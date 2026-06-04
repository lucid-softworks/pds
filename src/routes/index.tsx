import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatHz,
  formatPercent,
  type PdsStats,
} from '~/lib/stats'

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

      <section className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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

      </section>

      <HostPanel
        host={stats.host}
        blobBytes={stats.content.blobs.bytes}
        blobCount={stats.content.blobs.count}
      />

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

function HostPanel({
  host,
  blobBytes,
  blobCount,
}: {
  host: PdsStats['host']
  blobBytes: number
  blobCount: number
}) {
  const memPct = formatPercent(host.memory.used, host.memory.total)
  const heapPct = formatPercent(host.process.heapUsed, host.process.heapTotal)
  const diskPct = host.blobDisk
    ? formatPercent(host.blobDisk.used, host.blobDisk.total)
    : null
  return (
    <section className="mt-10">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--color-accent-2)]">
          Host
        </h2>
        <p className="font-mono text-xs text-[var(--color-fg-muted)] tabular-nums">
          {host.platform} {host.osRelease} · {host.arch} · Node {host.nodeVersion} · pid {host.pid}
        </p>
      </header>

      <div className="grid gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 md:grid-cols-2 lg:grid-cols-4">
        <HostGroup title="CPU">
          <HostLine k="model" v={host.cpu.model} />
          <HostLine k="cores" v={`${host.cpu.cores} @ ${formatHz(host.cpu.speedMhz)}`} />
          <HostSpacer />
          <HostLine k="load 1m" v={host.loadavg[0].toFixed(2)} />
          <HostLine k="load 5m" v={host.loadavg[1].toFixed(2)} />
          <HostLine k="load 15m" v={host.loadavg[2].toFixed(2)} />
        </HostGroup>

        <HostGroup title="Memory">
          <HostLine k="used" v={`${formatBytes(host.memory.used)} / ${formatBytes(host.memory.total)}`} />
          <HostLine k="free" v={formatBytes(host.memory.free)} />
          <HostLine k="usage" v={memPct} />
          <HostSpacer />
          <HostLine k="rss" v={formatBytes(host.process.rss)} />
          <HostLine k="heap" v={`${formatBytes(host.process.heapUsed)} / ${formatBytes(host.process.heapTotal)} (${heapPct})`} />
        </HostGroup>

        <HostGroup title="Disk">
          {host.blobDisk ? (
            <>
              <HostLine k="mount" v={host.blobDisk.mount} mono />
              <HostLine k="fs used" v={`${formatBytes(host.blobDisk.used)} / ${formatBytes(host.blobDisk.total)}`} />
              <HostLine k="fs usage" v={diskPct ?? '—'} />
              <HostSpacer />
              <HostLine k="blob data" v={`${formatBytes(blobBytes)} (${formatCount(blobCount)} ${blobCount === 1 ? 'file' : 'files'})`} />
            </>
          ) : (
            <p className="text-xs text-[var(--color-fg-muted)]">
              statfs unavailable on this platform.
            </p>
          )}
        </HostGroup>

        <HostGroup title="Uptime">
          <HostLine k="system" v={formatDuration(host.uptime)} />
          <HostLine k="process" v={formatDuration(host.processUptime)} />
        </HostGroup>
      </div>
    </section>
  )
}

function HostGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-fg-muted)]">
        {title}
      </h3>
      <dl className="space-y-1 text-xs font-mono">{children}</dl>
    </div>
  )
}

function HostLine({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-[var(--color-fg-muted)]">{k}</dt>
      <dd
        className={`truncate tabular-nums text-right${mono ? ' font-mono' : ''}`}
        title={v}
      >
        {v}
      </dd>
    </div>
  )
}

function HostSpacer() {
  return <div aria-hidden className="my-1 border-t border-[var(--color-border)]/40" />
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
