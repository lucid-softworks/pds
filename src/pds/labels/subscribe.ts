// Label subscription streaming — the read side of the `labels` table.
//
// Mirrors `src/pds/sequencer/firehose.ts` exactly in shape; the only
// difference is the source rows (labels rather than repo_seq) and the
// frame type names (`#labels` / `#info` from the canonical
// `com.atproto.label.subscribeLabels` lexicon).
//
// The transport is supplied by the caller (WebSocket in the production
// path, anything else in tests). We only know how to encode frames and
// pace them.
//
// See chapter 24 — Ozone-shaped moderation (Labels subsection).

import { asc, gt } from 'drizzle-orm'
import { db } from '~/lib/db'
import { labels, type Label } from '~/lib/db/schema'
import { encode } from '~/pds/codec'

export type LabelsClient = {
  bufferedFrames(): number
  send(frame: Uint8Array): Promise<void> | void
  close(code?: number, reason?: string): void
}

export type StreamOptions = {
  client: LabelsClient
  cursor?: number
  signal: AbortSignal
  batchSize?: number
  pollIntervalMs?: number
  backpressureLimit?: number
}

const DEFAULT_BATCH = 512
const DEFAULT_POLL_MS = 500
const DEFAULT_BACKPRESSURE = 1024

/** Replay labels strictly after `cursor`, then tail forever. Frame shape
 *  per the lexicon: a `#labels` body carrying { seq, labels: [...] },
 *  where each label is the canonical signed shape from
 *  `com.atproto.label.defs#label`. */
export async function streamLabels(opts: StreamOptions): Promise<void> {
  const {
    client,
    signal,
    batchSize = DEFAULT_BATCH,
    pollIntervalMs = DEFAULT_POLL_MS,
    backpressureLimit = DEFAULT_BACKPRESSURE,
  } = opts
  let cursor = opts.cursor ?? 0

  const head = await latestLabelSeq()
  if (cursor > head) {
    await sendError(client, 'FutureCursor', `cursor ${cursor} > latest ${head}`)
    client.close(1008, 'FutureCursor')
    return
  }

  // Replay phase.
  while (!signal.aborted) {
    const rows = await readLabelsSince({ cursor, limit: batchSize })
    if (rows.length === 0) break
    for (const row of rows) {
      if (signal.aborted) return
      if (client.bufferedFrames() > backpressureLimit) {
        await sendError(
          client,
          'ConsumerTooSlow',
          'send queue exceeded backpressure budget',
        )
        client.close(1013, 'ConsumerTooSlow')
        return
      }
      await sendLabel(client, row)
      cursor = row.seq
    }
    if (rows.length < batchSize) break
  }

  // Tail phase.
  while (!signal.aborted) {
    const rows = await readLabelsSince({ cursor, limit: batchSize })
    if (rows.length === 0) {
      await sleep(pollIntervalMs, signal)
      continue
    }
    for (const row of rows) {
      if (signal.aborted) return
      if (client.bufferedFrames() > backpressureLimit) {
        await sendError(
          client,
          'ConsumerTooSlow',
          'send queue exceeded backpressure budget',
        )
        client.close(1013, 'ConsumerTooSlow')
        return
      }
      await sendLabel(client, row)
      cursor = row.seq
    }
  }
}

async function sendLabel(client: LabelsClient, row: Label): Promise<void> {
  const header = await encode({ op: 1, t: '#labels' })
  // The lexicon allows batching multiple labels in one frame; we keep it
  // one-per-frame for simplicity and natural backpressure. Consumers
  // handle both shapes.
  const body = await encode({
    seq: row.seq,
    labels: [
      {
        src: row.src,
        uri: row.uri,
        ...(row.cid !== null ? { cid: row.cid } : {}),
        val: row.val,
        neg: row.neg,
        cts: row.cts.toISOString(),
        ...(row.exp !== null ? { exp: row.exp.toISOString() } : {}),
        sig: row.sig,
      },
    ],
  })
  await client.send(concat(header.bytes, body.bytes))
}

async function sendError(
  client: LabelsClient,
  error: string,
  message: string,
): Promise<void> {
  const header = await encode({ op: -1, error, message })
  await client.send(header.bytes)
}

async function latestLabelSeq(): Promise<number> {
  const rows = await db
    .select({ seq: labels.seq })
    .from(labels)
    .orderBy(asc(labels.seq))
  return rows.length === 0 ? 0 : rows[rows.length - 1]!.seq
}

async function readLabelsSince(args: {
  cursor: number
  limit: number
}): Promise<Label[]> {
  return db
    .select()
    .from(labels)
    .where(gt(labels.seq, args.cursor))
    .orderBy(asc(labels.seq))
    .limit(args.limit)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
