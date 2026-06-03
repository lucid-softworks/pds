// Behavior contract for the DAG-CBOR codec layer.
//
// The codec module's promise is: deterministic bytes for any value, a
// content-addressed CID for those bytes, and a strict decode path that
// refuses to hand back a value whose bytes don't hash to the declared CID.
// Every other PDS subsystem leans on these properties — MST determinism,
// repo signatures, CAR verification, etc.

import { describe, expect, it } from 'vitest'
import * as dagCbor from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import { cidEquals, cidForBytes, decode, encode, parseCid } from './index'

describe('encode/decode round-trip', () => {
  it('round-trips primitives', async () => {
    for (const v of [
      0,
      -1,
      42,
      true,
      false,
      null,
      'hello',
      'multi-byte: 漢字 🌳',
    ]) {
      const block = await encode(v)
      const back = await decode(block.bytes)
      expect(back).toEqual(v)
    }
  })

  it('round-trips nested objects', async () => {
    const value = {
      name: 'alice',
      age: 30,
      tags: ['a', 'b', 'c'],
      meta: { created: 1, updated: 2, nested: { x: [1, 2, 3] } },
    }
    const block = await encode(value)
    const back = await decode(block.bytes)
    expect(back).toEqual(value)
  })

  it('round-trips Uint8Array', async () => {
    const value = { bytes: new Uint8Array([1, 2, 3, 4, 5]) }
    const block = await encode(value)
    const back = await decode<typeof value>(block.bytes)
    expect(back.bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(back.bytes)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('DAG-CBOR canonical encoding', () => {
  it('encodes maps with the same keys in different orders to identical bytes', async () => {
    const a = await encode({ a: 1, b: 2, c: 3 })
    const b = await encode({ c: 3, b: 2, a: 1 })
    expect(a.bytes).toEqual(b.bytes)
    expect(cidEquals(a.cid, b.cid)).toBe(true)
  })

  it('produces the same CID for the same value across calls', async () => {
    const a = await encode({ hello: 'world', n: 42 })
    const b = await encode({ n: 42, hello: 'world' })
    expect(a.cid.toString()).toBe(b.cid.toString())
  })
})

describe('cidForBytes', () => {
  it('matches the CID returned by encode for the same bytes', async () => {
    const block = await encode({ x: 1, y: [1, 2, 3] })
    const cid = await cidForBytes(block.bytes)
    expect(cidEquals(cid, block.cid)).toBe(true)
  })
})

describe('decode verification', () => {
  it('returns the value when the expected CID matches', async () => {
    const block = await encode({ ok: true })
    const back = await decode<{ ok: boolean }>(block.bytes, block.cid)
    expect(back.ok).toBe(true)
  })

  it('throws when bytes do not hash to the expected CID', async () => {
    // Pre-compute a CID for ONE value, then try to decode a DIFFERENT
    // value's bytes against it.
    const a = await encode({ kind: 'a' })
    const b = await encode({ kind: 'b' })
    expect(cidEquals(a.cid, b.cid)).toBe(false)
    await expect(decode(b.bytes, a.cid)).rejects.toThrow(/CID mismatch/)
  })
})

describe('CID-link (tag 42) round-trip', () => {
  it('preserves a nested CID through encode/decode', async () => {
    const inner = await encode({ leaf: true })
    const value = { ref: inner.cid, label: 'pointer' }
    const block = await encode(value)
    const back = await decode<{ ref: CID; label: string }>(block.bytes)
    expect(back.label).toBe('pointer')
    // DAG-CBOR uses tag 42 for CIDs; @ipld/dag-cbor decodes it back into a
    // CID instance, so equality holds via .equals().
    expect(CID.asCID(back.ref)).not.toBeNull()
    expect(cidEquals(back.ref, inner.cid)).toBe(true)
  })

  it('parseCid round-trips through string form', async () => {
    const block = await encode({ x: 1 })
    const parsed = parseCid(block.cid.toString())
    expect(cidEquals(parsed, block.cid)).toBe(true)
  })

  it('produces tag-42 wire encoding for CID references', async () => {
    const inner = await encode({ leaf: 1 })
    const block = await encode({ ref: inner.cid })
    // Decode at the raw cbor layer; the value should come back as a CID
    // instance (proving the round-trip uses tag 42, not an opaque object).
    const raw = dagCbor.decode<{ ref: unknown }>(block.bytes)
    expect(CID.asCID(raw.ref)).not.toBeNull()
  })
})
