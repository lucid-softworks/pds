// Behavior contract for the CAR v1 decoder.
//
// The decoder's load-bearing promise: every emitted block is hash-verified
// against its declared CID. If a peer ships us a CAR with a tampered block,
// we must refuse it — otherwise the entire content-addressing story falls
// apart.

import { describe, expect, it } from 'vitest'
import { encode } from '~/pds/codec'
import { encodeCar, encodeVarint } from './encode'
import { decodeCar, decodeCarChunks, runCarSelfTest } from './decode'

describe('decodeCar', () => {
  it('round-trips a CAR built by encodeCar', async () => {
    const a = await encode({ leaf: 'a' })
    const b = await encode({ leaf: 'b' })
    const root = await encode({ root: true, kids: [a.cid, b.cid] })
    const bytes = await encodeCar({
      roots: [root.cid],
      blocks: [a, b, root],
    })
    const { header, blocks } = await decodeCar(bytes)
    expect(header.version).toBe(1)
    expect(header.roots[0]!.equals(root.cid)).toBe(true)
    expect(blocks.map((b) => b.cid.toString())).toEqual([
      a.cid.toString(),
      b.cid.toString(),
      root.cid.toString(),
    ])
  })

  it('rejects a CAR with a tampered block (hash mismatch)', async () => {
    const a = await encode({ leaf: 'a' })
    const root = await encode({ root: true })
    const bytes = await encodeCar({
      roots: [root.cid],
      blocks: [a, root],
    })

    // Surgically corrupt the first block's payload byte. We know the layout:
    //   varint(headerLen) | headerBytes | varint(blockBodyLen) | cid(36) | data
    // So we walk past the header, past the first block-len varint, past the
    // 36-byte CID, then flip a byte in the payload.
    const headerLenVarint = readVarintInPlace(bytes, 0)
    let off = headerLenVarint.size + headerLenVarint.value
    const blockLenVarint = readVarintInPlace(bytes, off)
    off += blockLenVarint.size
    // Skip the CID (36 bytes for our PDS shape: dag-cbor + sha2-256).
    const payloadStart = off + 36
    const tampered = new Uint8Array(bytes)
    tampered[payloadStart] = (tampered[payloadStart]! ^ 0xff) & 0xff
    await expect(decodeCar(tampered)).rejects.toThrow(
      /do not hash to declared CID/,
    )
  })
})

describe('decodeCarChunks (streaming)', () => {
  it('emits a header event then one event per block, in order', async () => {
    const a = await encode({ n: 1 })
    const b = await encode({ n: 2 })
    const root = await encode({ root: true })
    const carBytes = await encodeCar({
      roots: [root.cid],
      blocks: [a, b, root],
    })
    // Feed the bytes as a 1-byte-per-chunk async iterable to exercise the
    // chunk-reader buffering path.
    async function* trickle(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < carBytes.length; i++) {
        yield carBytes.subarray(i, i + 1)
      }
    }
    const events: string[] = []
    const cids: string[] = []
    for await (const evt of decodeCarChunks(trickle())) {
      events.push(evt.type)
      if (evt.type === 'block') cids.push(evt.cid.toString())
    }
    expect(events).toEqual(['header', 'block', 'block', 'block'])
    expect(cids).toEqual([
      a.cid.toString(),
      b.cid.toString(),
      root.cid.toString(),
    ])
  })
})

describe('runCarSelfTest', () => {
  it('passes', async () => {
    await expect(runCarSelfTest()).resolves.toBeUndefined()
  })
})

// ----- helpers --------------------------------------------------------------

function readVarintInPlace(
  bytes: Uint8Array,
  start: number,
): { value: number; size: number } {
  let value = 0
  let shift = 1
  let i = start
  while (i < bytes.length) {
    const byte = bytes[i]!
    i++
    value += (byte & 0x7f) * shift
    if ((byte & 0x80) === 0) return { value, size: i - start }
    shift *= 128
  }
  throw new Error('truncated varint')
}

// Reference the encoder's varint helper so the import isn't pruned by the
// linter — it documents which helper our hand-rolled reader mirrors.
void encodeVarint
