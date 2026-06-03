// Behavior contract for the CAR v1 encoder.
//
// The encoder is one half of the firehose + getRepo wire format. It must:
//   - emit a length-prefixed DAG-CBOR header naming the roots
//   - emit each block as `varint(cid_len + bytes_len) || cid_bytes || bytes`
//   - work both as a single-Uint8Array buffer and as an async chunk stream
//
// We test the round-trip against the in-house decoder; cross-tool fixtures
// live with the chapter.

import { describe, expect, it } from 'vitest'
import { encode } from '~/pds/codec'
import { decodeCar } from './decode'
import { encodeCar, encodeCarChunks, encodeVarint } from './encode'

describe('encodeCar', () => {
  it('round-trips a 1-root, 3-block CAR', async () => {
    const a = await encode({ kind: 'leaf', n: 1 })
    const b = await encode({ kind: 'leaf', n: 2 })
    const root = await encode({ kind: 'root', children: [a.cid, b.cid] })
    const blocks = [a, b, root]
    const bytes = await encodeCar({ roots: [root.cid], blocks })
    const decoded = await decodeCar(bytes)
    expect(decoded.header.version).toBe(1)
    expect(decoded.header.roots).toHaveLength(1)
    expect(decoded.header.roots[0]!.equals(root.cid)).toBe(true)
    expect(decoded.blocks).toHaveLength(3)
    for (let i = 0; i < blocks.length; i++) {
      expect(decoded.blocks[i]!.cid.equals(blocks[i]!.cid)).toBe(true)
      expect(Array.from(decoded.blocks[i]!.bytes)).toEqual(
        Array.from(blocks[i]!.bytes),
      )
    }
  })

  it('produces identical bytes for the same input', async () => {
    const a = await encode({ x: 1 })
    const b = await encode({ x: 2 })
    const root = await encode({ root: true })
    const blocks = [a, b, root]
    const out1 = await encodeCar({ roots: [root.cid], blocks })
    const out2 = await encodeCar({ roots: [root.cid], blocks })
    expect(out1).toEqual(out2)
  })
})

describe('encodeVarint', () => {
  it('encodes small numbers in 1 byte', () => {
    for (const n of [0, 1, 0x7f]) {
      const buf = encodeVarint(n)
      expect(buf).toHaveLength(1)
      expect(buf[0]).toBe(n)
    }
  })

  it('rejects negative or non-integer inputs', () => {
    expect(() => encodeVarint(-1)).toThrow()
    expect(() => encodeVarint(1.5)).toThrow()
  })

  it('round-trips multi-byte values via the CAR length prefix', async () => {
    // Pick a value that requires >1 byte to encode. 200 bytes of payload =>
    // 2-byte varint for the block-body length.
    const big = await encode({ filler: 'x'.repeat(200) })
    const root = await encode({ root: true })
    const out = await encodeCar({ roots: [root.cid], blocks: [big, root] })
    const decoded = await decodeCar(out)
    expect(decoded.blocks).toHaveLength(2)
    expect(Array.from(decoded.blocks[0]!.bytes)).toEqual(Array.from(big.bytes))
  })
})

describe('encodeCarChunks (streaming)', () => {
  it('yields exactly N+1 chunks for N blocks', async () => {
    const a = await encode({ x: 1 })
    const b = await encode({ x: 2 })
    const root = await encode({ r: true })
    const chunks: Uint8Array[] = []
    for await (const c of encodeCarChunks({
      roots: [root.cid],
      blocks: [a, b, root],
    })) {
      chunks.push(c)
    }
    // First chunk is the header; one per block after that.
    expect(chunks).toHaveLength(4)
    // The concatenation must match the buffered encoder.
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const concat = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      concat.set(c, off)
      off += c.length
    }
    const buffered = await encodeCar({
      roots: [root.cid],
      blocks: [a, b, root],
    })
    expect(Array.from(concat)).toEqual(Array.from(buffered))
  })
})
