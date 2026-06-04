// Server-only query for the home-page stats. Imports the Postgres driver
// via `~/lib/db`, which is incompatible with the client bundle — so this
// module is *only* loaded via a dynamic import from a createServerFn
// handler. The matching pure-TS half (type + formatters) lives in
// `./stats.ts` and is safe to import statically.

import * as os from 'node:os'
import { statfs } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, blobs, records, repoSeq, repos } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import type { PdsStats } from './stats'

export async function getPdsStats(): Promise<PdsStats> {
  const cfg = getConfig()

  const accountStatusRows = await db
    .select({
      status: accounts.status,
      n: sql<number>`count(*)::int`,
    })
    .from(accounts)
    .groupBy(accounts.status)
  const byStatus: Record<string, number> = {}
  for (const row of accountStatusRows) byStatus[row.status] = Number(row.n)
  const accountsTotal = Object.values(byStatus).reduce((a, b) => a + b, 0)

  const [repoCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(repos)
  const [recordCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(records)
  const [blobAggRow] = await db
    .select({
      n: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(size), 0)::bigint`,
    })
    .from(blobs)

  const [latestSeqRow] = await db
    .select({ seq: sql<number>`coalesce(max(seq), 0)::bigint` })
    .from(repoSeq)
  const seqByTypeRows = await db
    .select({
      eventType: repoSeq.eventType,
      n: sql<number>`count(*)::int`,
    })
    .from(repoSeq)
    .groupBy(repoSeq.eventType)
  const eventCounts = { commit: 0, identity: 0, account: 0, tombstone: 0 }
  for (const row of seqByTypeRows) {
    const key = row.eventType.replace(/^#/, '') as keyof typeof eventCounts
    if (key in eventCounts) eventCounts[key] = Number(row.n)
  }

  return {
    service: {
      did: cfg.serviceDid,
      publicUrl: cfg.publicUrl,
      hostname: cfg.hostname,
      inviteRequired: cfg.inviteRequired,
      localPlcOnly: cfg.localPlcOnly,
    },
    accounts: {
      total: accountsTotal,
      active: byStatus.active ?? 0,
      deactivated: byStatus.deactivated ?? 0,
      takendown: byStatus.takendown ?? 0,
      deleted: byStatus.deleted ?? 0,
    },
    content: {
      repos: Number(repoCountRow?.n ?? 0),
      records: Number(recordCountRow?.n ?? 0),
      blobs: {
        count: Number(blobAggRow?.n ?? 0),
        bytes: Number(blobAggRow?.bytes ?? 0),
      },
    },
    firehose: {
      latestSeq: Number(latestSeqRow?.seq ?? 0),
      eventCounts,
    },
    host: await getHostStats(),
  }
}

async function getHostStats(): Promise<PdsStats['host']> {
  const load = os.loadavg()
  const total = os.totalmem()
  const free = os.freemem()
  const cpus = os.cpus()
  const first = cpus[0]
  const mem = process.memoryUsage()
  return {
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.release(),
    nodeVersion: process.version,
    pid: process.pid,
    cpu: {
      model: first?.model.trim() ?? 'unknown',
      cores: cpus.length,
      speedMhz: first?.speed ?? 0,
    },
    loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    memory: { used: total - free, total, free },
    process: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    uptime: Math.floor(os.uptime()),
    processUptime: Math.floor(process.uptime()),
    blobDisk: await getBlobDiskStats(),
  }
}

async function getBlobDiskStats(): Promise<PdsStats['host']['blobDisk']> {
  const mount = getConfig().blobStoreDir
  try {
    const s = await statfs(mount)
    const total = Number(s.bsize) * Number(s.blocks)
    const free = Number(s.bsize) * Number(s.bavail)
    return { used: total - free, total, mount }
  } catch {
    return null
  }
}
