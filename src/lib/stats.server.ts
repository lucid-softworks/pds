// Server-only query for the home-page stats. Imports the Postgres driver
// via `~/lib/db`, which is incompatible with the client bundle — so this
// module is *only* loaded via a dynamic import from a createServerFn
// handler. The matching pure-TS half (type + formatters) lives in
// `./stats.ts` and is safe to import statically.

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
  }
}
