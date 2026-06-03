// Shape of the home-page stats payload + the small formatting helpers the
// component uses. Pure — no DB imports — so this module can be imported
// from a TanStack route file without dragging the Postgres driver into the
// client bundle.
//
// The actual query lives in `src/lib/stats.server.ts` and is dynamic-
// imported from the createServerFn handler in `src/routes/index.tsx`.

export type PdsStats = {
  service: {
    did: string
    publicUrl: string
    hostname: string
    inviteRequired: boolean
    localPlcOnly: boolean
  }
  accounts: {
    total: number
    active: number
    deactivated: number
    takendown: number
    deleted: number
  }
  content: {
    repos: number
    records: number
    blobs: { count: number; bytes: number }
  }
  firehose: {
    latestSeq: number
    eventCounts: {
      commit: number
      identity: number
      account: number
      tombstone: number
    }
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
