// Firehose streaming — the read side of `repo_seq`.
//
// `sequence.ts` is the writer; this module is the reader. It pulls a slice
// of historical events on connect, then tails new ones, framing each row in
// the two-CBOR-objects shape that `com.atproto.sync.subscribeRepos` defines
// and pushing them to a transport-agnostic `FirehoseClient`.
//
// The transport (WebSocket vs SSE vs fake-in-memory for tests) is supplied
// by the caller. We only know how to encode frames and pace them.
//
// See chapter 16 — Event sequencer and the firehose.

import { encode } from '~/pds/codec'
import { latestSeq, readEventsSince } from './sequence'

/** Minimal interface the streaming loop needs from a transport. The route
 *  glues this to whatever WebSocket library it has. */
export type FirehoseClient = {
  /** How many frames are queued but not yet flushed to the network. Used
   *  for backpressure — when this exceeds the budget, we disconnect. */
  bufferedFrames(): number
  /** Send one framed message (header CBOR + payload bytes, concatenated). */
  send(frame: Uint8Array): Promise<void> | void
  /** Close the connection with an optional WebSocket close code + reason. */
  close(code?: number, reason?: string): void
}

export type StreamOptions = {
  client: FirehoseClient
  cursor?: number
  signal: AbortSignal
  /** Replay batch size. Default 512 — small enough to keep the SQL row
   *  buffer bounded, large enough to amortise the round-trip. */
  batchSize?: number
  /** Polling interval (ms) for the tail loop. PGlite has no LISTEN/NOTIFY;
   *  in production this is replaced with pub-sub. */
  pollIntervalMs?: number
  /** Max queued frames before we declare the consumer too slow. */
  backpressureLimit?: number
}

const DEFAULT_BATCH = 512
const DEFAULT_POLL_MS = 500
const DEFAULT_BACKPRESSURE = 1024

/** Replay events strictly after `cursor`, then tail live events until the
 *  client disconnects or `signal` aborts. */
export async function streamFirehose(opts: StreamOptions): Promise<void> {
  const {
    client,
    signal,
    batchSize = DEFAULT_BATCH,
    pollIntervalMs = DEFAULT_POLL_MS,
    backpressureLimit = DEFAULT_BACKPRESSURE,
  } = opts
  let cursor = opts.cursor ?? 0

  // FutureCursor: a client asking for a seq we've never assigned almost
  // certainly has stale state. Bail with a structured error frame rather
  // than silently waiting for the log to catch up.
  const head = await latestSeq()
  if (cursor > head) {
    await sendError(client, 'FutureCursor', `cursor ${cursor} > latest ${head}`)
    client.close(1008, 'FutureCursor')
    return
  }

  // Replay phase — drain history in `batchSize` chunks. We loop until a
  // batch returns short, meaning we've caught up to (or near) `latestSeq`.
  while (!signal.aborted) {
    const rows = await readEventsSince({ cursor, limit: batchSize })
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
      await sendEvent(client, row.eventType, row.event)
      cursor = row.seq
    }
    if (rows.length < batchSize) break
  }

  // Tail phase — poll for new rows. PGlite doesn't ship LISTEN/NOTIFY;
  // production Postgres would replace this with a `NOTIFY repo_seq` wake-up
  // emitted from `emit*` after the UPDATE.
  while (!signal.aborted) {
    const rows = await readEventsSince({ cursor, limit: batchSize })
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
      await sendEvent(client, row.eventType, row.event)
      cursor = row.seq
    }
  }
}

/** Wrap raw event bytes with a `{ op: 1, t: <type> }` header and send. */
async function sendEvent(
  client: FirehoseClient,
  eventType: string,
  payload: Uint8Array,
): Promise<void> {
  const header = await encode({ op: 1, t: eventType })
  const frame = concat(header.bytes, payload)
  await client.send(frame)
}

/** Build and send an `op: -1` error frame. The payload carries the canonical
 *  error name (e.g. FutureCursor, ConsumerTooSlow) plus a human message. */
async function sendError(
  client: FirehoseClient,
  error: string,
  message: string,
): Promise<void> {
  const header = await encode({ op: -1, error, message })
  // The error-frame "payload" overlaps with the header on the wire — the
  // spec only requires the single CBOR object. Sending just the header
  // matches what the upstream PDS does.
  await client.send(header.bytes)
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
