// WebSocket firehose — end-to-end coverage for `streamFirehose`.
//
// `sequence.test.ts` pins the write side of `repo_seq`. This file pins the
// read side: the replay-then-tail loop in `firehose.ts` that the WebSocket
// route (firehose-mount.ts) sits on top of. We bypass the WebSocket layer
// entirely — `streamFirehose` is transport-agnostic, so a tiny in-memory
// `TestFirehoseClient` is enough to assert on:
//
//   - cursor=0 replays everything in seq order
//   - cursor=N skips events with seq ≤ N
//   - the tail loop picks up rows written after the historical drain
//   - cursor > latestSeq produces a single `op:-1, error:'FutureCursor'`
//     frame and closes the socket with 1008
//   - aborting the AbortController stops the stream cleanly
//   - frame bytes round-trip through DAG-CBOR with no field corruption
//   - `#identity` and `#account` events frame with the right `t` tag
//
// Backpressure / ConsumerTooSlow is exercised in a separate test — see the
// comment above that case for why it's stable.
//
// Frame format reminder: each frame is `header.bytes ++ event.bytes`, two
// DAG-CBOR objects back-to-back with no separator. To verify a frame, we
// re-encode the header we expect and slice the buffer at that offset, then
// `decode` each half. DAG-CBOR is deterministic so the same header object
// always produces the same byte sequence.

import { setupTestDbEnv, migrateProcessDb } from '../db'

// IMPORTANT: must run before any import that touches `~/lib/db`.
setupTestDbEnv()

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decode, encode } from '~/pds/codec'
import { streamFirehose, type FirehoseClient } from '~/pds/sequencer/firehose'
import {
  emitAccount,
  emitCommit,
  emitIdentity,
  latestSeq,
} from '~/pds/sequencer/sequence'

beforeAll(async () => {
  await migrateProcessDb()
})

// ──── helpers ────────────────────────────────────────────────────────────

const TEST_DID = 'did:plc:fhtestaaaaaaaaaaaaaaaaaaa'

/** In-memory `FirehoseClient` that captures every frame and can simulate
 *  a backpressured consumer via `sendDelayMs` and a settable
 *  `bufferedFrames()` return. */
class TestFirehoseClient implements FirehoseClient {
  frames: Uint8Array[] = []
  closed: { code?: number; reason?: string } | null = null
  /** Optional artificial latency per `send`. Drives the ConsumerTooSlow
   *  case by letting `repo_seq` rows accumulate behind us. */
  sendDelayMs = 0
  /** Reported buffer depth. The real `ws` client tracks bytes; for the
   *  test we just count un-flushed frames or hold a fixed override. */
  private bufferedOverride: number | null = null

  bufferedFrames(): number {
    if (this.bufferedOverride !== null) return this.bufferedOverride
    return 0
  }

  setBufferedOverride(n: number | null): void {
    this.bufferedOverride = n
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.sendDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.sendDelayMs))
    }
    this.frames.push(frame)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
}

/** Split a firehose frame at the boundary between header and payload by
 *  re-encoding the expected header and using its byte length. Returns
 *  `{ header, payload }` with both halves DAG-CBOR-decoded. */
async function splitFrame(
  frame: Uint8Array,
  expectedHeader: unknown,
): Promise<{ header: unknown; payload: unknown }> {
  const enc = await encode(expectedHeader)
  if (frame.length < enc.bytes.length) {
    throw new Error(
      `frame is shorter (${frame.length}) than expected header (${enc.bytes.length})`,
    )
  }
  const headerBytes = frame.slice(0, enc.bytes.length)
  const payloadBytes = frame.slice(enc.bytes.length)
  const header = await decode(headerBytes)
  // FutureCursor / ConsumerTooSlow frames are header-only. The
  // `sendError` path sends exactly one CBOR object, so payloadBytes is
  // empty for them.
  const payload =
    payloadBytes.length === 0 ? null : await decode(payloadBytes)
  return { header, payload }
}

/** Build a minimal but well-formed commit-event payload. Field values are
 *  arbitrary — `emitCommit` doesn't validate them — but they're consistent
 *  across calls so test assertions can compare. The `suffix` makes the
 *  underlying CID unique per call so we never violate any future
 *  uniqueness constraint. */
async function makeCommitEvent(suffix: string) {
  const block = await encode({ test: 'commit-payload', suffix })
  return {
    did: TEST_DID,
    commitCid: block.cid,
    rev: '3jzfcijpj2z2a',
    prevRev: null,
    carBytes: block.bytes,
    ops: [
      {
        action: 'create' as const,
        path: 'app.bsky.feed.post/' + suffix,
        cid: block.cid,
      },
    ],
  }
}

/** Tiny sleep without an abort signal — for letting the streaming loop
 *  make progress between assertions. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Drive `streamFirehose` in the background. Returns the AbortController
 *  + a promise that resolves when the stream exits (for cleanup). */
function startStream(opts: {
  client: TestFirehoseClient
  cursor?: number
  batchSize?: number
  pollIntervalMs?: number
  backpressureLimit?: number
}): { controller: AbortController; done: Promise<void> } {
  const controller = new AbortController()
  const done = streamFirehose({
    client: opts.client,
    cursor: opts.cursor,
    signal: controller.signal,
    batchSize: opts.batchSize,
    pollIntervalMs: opts.pollIntervalMs,
    backpressureLimit: opts.backpressureLimit,
  })
  return { controller, done }
}

// ──── tests ──────────────────────────────────────────────────────────────

describe('streamFirehose — replay', () => {
  it('cursor=0 replays every historical event in seq order', async () => {
    const s1 = await emitCommit(await makeCommitEvent('rep-1'))
    const s2 = await emitCommit(await makeCommitEvent('rep-2'))
    const s3 = await emitCommit(await makeCommitEvent('rep-3'))

    const client = new TestFirehoseClient()
    // Short poll interval so the stream notices "no new rows" quickly and
    // sits idle in tail; we abort after the historical drain.
    const { controller, done } = startStream({
      client,
      cursor: 0,
      pollIntervalMs: 50,
    })

    // Give the replay loop a beat to drain history. PGlite is in-process
    // so this is fast.
    await wait(100)
    controller.abort()
    await done

    // The three frames we emitted should all be present, in order. There
    // may also be frames from earlier tests' emits if PGlite shared state —
    // since each test file gets a fresh PGlite directory via setupTestDbEnv,
    // this file is the only writer.
    expect(client.frames.length).toBeGreaterThanOrEqual(3)
    // The last three should match s1, s2, s3.
    const tail = client.frames.slice(-3)
    const seqs: number[] = []
    for (const frame of tail) {
      const { header, payload } = await splitFrame(frame, {
        op: 1,
        t: '#commit',
      })
      expect(header).toEqual({ op: 1, t: '#commit' })
      expect(payload).toMatchObject({ repo: TEST_DID })
      seqs.push((payload as { seq: number }).seq)
    }
    expect(seqs).toEqual([s1, s2, s3])
  })

  it('cursor=N skips events with seq ≤ N', async () => {
    const sA = await emitCommit(await makeCommitEvent('skip-1'))
    const sB = await emitCommit(await makeCommitEvent('skip-2'))
    const sC = await emitCommit(await makeCommitEvent('skip-3'))

    const client = new TestFirehoseClient()
    const { controller, done } = startStream({
      client,
      cursor: sA,
      pollIntervalMs: 50,
    })
    await wait(100)
    controller.abort()
    await done

    // Pull out the seq of every received frame and verify all are > sA.
    const receivedSeqs: number[] = []
    for (const frame of client.frames) {
      const { payload } = await splitFrame(frame, {
        op: 1,
        t: '#commit',
      })
      const seq = (payload as { seq: number }).seq
      receivedSeqs.push(seq)
      expect(seq).toBeGreaterThan(sA)
    }
    expect(receivedSeqs).toContain(sB)
    expect(receivedSeqs).toContain(sC)
    expect(receivedSeqs).not.toContain(sA)
  })
})

describe('streamFirehose — live tail', () => {
  it('picks up events emitted after the historical drain', async () => {
    const head = await latestSeq()
    const s1 = await emitCommit(await makeCommitEvent('tail-1'))
    const s2 = await emitCommit(await makeCommitEvent('tail-2'))

    const client = new TestFirehoseClient()
    const { controller, done } = startStream({
      client,
      cursor: head,
      pollIntervalMs: 50,
    })

    // Let the replay drain the two we just emitted.
    await wait(100)
    expect(client.frames.length).toBeGreaterThanOrEqual(2)
    const drained = client.frames.length

    // Emit two more *after* the replay phase should have settled.
    const s3 = await emitCommit(await makeCommitEvent('tail-3'))
    const s4 = await emitCommit(await makeCommitEvent('tail-4'))

    // The tail loop polls every 50ms; give it two iterations.
    await wait(200)
    controller.abort()
    await done

    expect(client.frames.length).toBeGreaterThanOrEqual(drained + 2)

    // Verify the four expected seqs (s1..s4) all show up in order.
    const allSeqs: number[] = []
    for (const frame of client.frames) {
      const { payload } = await splitFrame(frame, {
        op: 1,
        t: '#commit',
      })
      allSeqs.push((payload as { seq: number }).seq)
    }
    for (let i = 1; i < allSeqs.length; i++) {
      expect(allSeqs[i]!).toBeGreaterThan(allSeqs[i - 1]!)
    }
    for (const seq of [s1, s2, s3, s4]) {
      expect(allSeqs).toContain(seq)
    }
  })
})

describe('streamFirehose — FutureCursor', () => {
  it('emits one op:-1 error frame and closes with 1008', async () => {
    const client = new TestFirehoseClient()
    // Wildly past anything we've emitted — small enough not to overflow
    // a JS number, large enough to never be reached by this test file.
    const ahead = 9_999_999
    const { controller, done } = startStream({
      client,
      cursor: ahead,
      pollIntervalMs: 50,
    })
    await done // FutureCursor returns immediately — no need to abort.
    controller.abort() // belt-and-braces

    expect(client.frames).toHaveLength(1)
    const headerOnly = client.frames[0]!
    const header = await decode(headerOnly)
    expect(header).toMatchObject({
      op: -1,
      error: 'FutureCursor',
    })
    expect(client.closed).not.toBeNull()
    expect(client.closed!.code).toBe(1008)
    expect(client.closed!.reason).toBe('FutureCursor')
  })
})

describe('streamFirehose — abort signal', () => {
  it('stops the stream and ignores events emitted after abort', async () => {
    const head = await latestSeq()
    await emitCommit(await makeCommitEvent('abort-1'))
    await emitCommit(await makeCommitEvent('abort-2'))

    const client = new TestFirehoseClient()
    const { controller, done } = startStream({
      client,
      cursor: head,
      pollIntervalMs: 50,
    })

    // Let the historical replay drain.
    await wait(100)
    const beforeAbort = client.frames.length
    controller.abort()
    await done

    // Now emit something extra. The stream is gone — these must not appear.
    await emitCommit(await makeCommitEvent('abort-post-1'))
    await emitCommit(await makeCommitEvent('abort-post-2'))
    await wait(150) // longer than poll interval; if the loop were alive it'd see them

    expect(client.frames.length).toBe(beforeAbort)
  })
})

describe('streamFirehose — decode round-trip', () => {
  it('frame payload decodes to the exact CommitEvent fields we passed in', async () => {
    const head = await latestSeq()
    const evt = await makeCommitEvent('roundtrip')
    const seq = await emitCommit(evt)

    const client = new TestFirehoseClient()
    const { controller, done } = startStream({
      client,
      cursor: head,
      pollIntervalMs: 50,
    })
    await wait(100)
    controller.abort()
    await done

    // The frame whose decoded payload has `seq === <our seq>` is ours.
    let matched: { header: unknown; payload: unknown } | null = null
    for (const frame of client.frames) {
      const split = await splitFrame(frame, { op: 1, t: '#commit' })
      if ((split.payload as { seq?: number } | null)?.seq === seq) {
        matched = split
        break
      }
    }
    expect(matched).not.toBeNull()

    const payload = matched!.payload as {
      seq: number
      repo: string
      rev: string
      since: string | null
      commit: unknown
      ops: Array<{ action: string; path: string }>
      blocks: Uint8Array
    }
    expect(payload.seq).toBe(seq)
    expect(payload.repo).toBe(evt.did)
    expect(payload.rev).toBe(evt.rev)
    expect(payload.since).toBe(evt.prevRev)
    // ops survived encode/decode intact.
    expect(payload.ops).toHaveLength(1)
    expect(payload.ops[0]!.action).toBe('create')
    expect(payload.ops[0]!.path).toBe(evt.ops[0]!.path)
    // CAR bytes round-trip byte-for-byte.
    expect(payload.blocks).toBeInstanceOf(Uint8Array)
    expect(Array.from(payload.blocks)).toEqual(Array.from(evt.carBytes))
  })
})

describe('streamFirehose — identity and account events', () => {
  it('#identity frame carries the right header tag and did/handle', async () => {
    const head = await latestSeq()
    const seq = await emitIdentity({ did: TEST_DID, handle: 'alice.test' })

    const client = new TestFirehoseClient()
    const { controller, done } = startStream({
      client,
      cursor: head,
      pollIntervalMs: 50,
    })
    await wait(100)
    controller.abort()
    await done

    let matched: { header: unknown; payload: unknown } | null = null
    for (const frame of client.frames) {
      const split = await splitFrame(frame, { op: 1, t: '#identity' })
      if ((split.payload as { seq?: number } | null)?.seq === seq) {
        matched = split
        break
      }
    }
    expect(matched).not.toBeNull()
    expect(matched!.header).toEqual({ op: 1, t: '#identity' })
    const payload = matched!.payload as {
      seq: number
      did: string
      handle?: string
    }
    expect(payload.did).toBe(TEST_DID)
    expect(payload.handle).toBe('alice.test')
  })

  it('#account frame carries the right header tag and did/active', async () => {
    const head = await latestSeq()
    const seq = await emitAccount({ did: TEST_DID, active: true })

    const client = new TestFirehoseClient()
    const { controller, done } = startStream({
      client,
      cursor: head,
      pollIntervalMs: 50,
    })
    await wait(100)
    controller.abort()
    await done

    let matched: { header: unknown; payload: unknown } | null = null
    for (const frame of client.frames) {
      const split = await splitFrame(frame, { op: 1, t: '#account' })
      if ((split.payload as { seq?: number } | null)?.seq === seq) {
        matched = split
        break
      }
    }
    expect(matched).not.toBeNull()
    expect(matched!.header).toEqual({ op: 1, t: '#account' })
    const payload = matched!.payload as {
      seq: number
      did: string
      active: boolean
    }
    expect(payload.did).toBe(TEST_DID)
    expect(payload.active).toBe(true)
  })
})

describe('streamFirehose — ConsumerTooSlow backpressure', () => {
  it(
    'emits ConsumerTooSlow when bufferedFrames exceeds the backpressureLimit',
    async () => {
      // The real backpressure path watches `ws.bufferedAmount` — bytes
      // queued at the OS / `ws` layer. We don't have a real socket here,
      // so we cheat: force `bufferedFrames()` to report over the limit and
      // verify the loop catches it and emits the error frame.
      //
      // This still exercises the read side of the contract — the check, the
      // structured error frame, the close call. The thing it does NOT test
      // is whether `ws.bufferedAmount` accurately tracks pending writes,
      // which is `ws`'s responsibility, not ours.
      const head = await latestSeq()
      await emitCommit(await makeCommitEvent('bp-1'))
      await emitCommit(await makeCommitEvent('bp-2'))

      const client = new TestFirehoseClient()
      client.setBufferedOverride(2000) // way above the default 1024

      const { controller, done } = startStream({
        client,
        cursor: head,
        pollIntervalMs: 50,
        backpressureLimit: 1024,
      })

      // The first row through the loop should trip the backpressure check
      // and immediately exit. No abort needed — the function returns on
      // its own — but we abort as a safety net in case it doesn't.
      await Promise.race([done, wait(500)])
      controller.abort()
      await done

      // Find a `op:-1, error:'ConsumerTooSlow'` frame. The replay loop
      // checks backpressure *before* sending the next event, so the
      // ConsumerTooSlow frame may be the only one we got.
      let sawConsumerTooSlow = false
      for (const frame of client.frames) {
        try {
          const decoded = (await decode(frame)) as {
            op?: number
            error?: string
          }
          if (decoded.op === -1 && decoded.error === 'ConsumerTooSlow') {
            sawConsumerTooSlow = true
            break
          }
        } catch {
          // Multi-object frame — not the error frame we're looking for.
        }
      }
      expect(sawConsumerTooSlow).toBe(true)
      expect(client.closed).not.toBeNull()
      expect(client.closed!.code).toBe(1013)
      expect(client.closed!.reason).toBe('ConsumerTooSlow')
    },
    5000,
  )
})

// Catch-all afterAll: nothing to clean up (PGlite directory is per-file and
// torn down by vitest's process exit), but having the hook here makes the
// shape of the file match other integration tests.
afterAll(async () => {})
