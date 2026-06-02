// CAR v1 decoder.
//
// Mirror of encode.ts: parses varint-framed blocks, decodes the header,
// hash-verifies each block against its declared CID, and emits them.
//
// Two surfaces:
//   - decodeCar(bytes)  — buffered, returns header + array of blocks.
//   - decodeCarChunks() — streaming, emits the header then each block as
//                         soon as its bytes have all arrived.
//
// The streaming form is the right shape for `subscribeRepos` consumers and
// for verifying multi-megabyte `getRepo` responses without buffering the
// whole CAR in memory.

import * as dagCbor from '@ipld/dag-cbor'
import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'

export type CarHeader = { version: 1; roots: CID[] }

export type CarBlock = { cid: CID; bytes: Uint8Array }

export type CarChunkEvent =
  | { type: 'header'; header: CarHeader }
  | { type: 'block'; cid: CID; bytes: Uint8Array }

export async function decodeCar(
  bytes: Uint8Array,
): Promise<{ header: CarHeader; blocks: CarBlock[] }> {
  let header: CarHeader | null = null
  const blocks: CarBlock[] = []
  for await (const event of decodeCarChunks(bytes)) {
    if (event.type === 'header') header = event.header
    else blocks.push({ cid: event.cid, bytes: event.bytes })
  }
  if (!header) throw new Error('CAR: stream ended before header')
  return { header, blocks }
}

export async function* decodeCarChunks(
  source: AsyncIterable<Uint8Array> | Uint8Array,
): AsyncGenerator<CarChunkEvent> {
  const reader = new ChunkReader(source)

  const headerLen = await reader.readVarint()
  const headerBytes = await reader.readExact(headerLen)
  const header = parseHeader(headerBytes)
  yield { type: 'header', header }

  while (!(await reader.atEnd())) {
    const bodyLen = await reader.readVarint()
    const body = await reader.readExact(bodyLen)
    const { cid, cidLen } = parseCidPrefix(body)
    const blockBytes = body.subarray(cidLen)
    await verifyHash(cid, blockBytes)
    yield { type: 'block', cid, bytes: blockBytes }
  }
}

function parseHeader(bytes: Uint8Array): CarHeader {
  const decoded = dagCbor.decode<{ version: unknown; roots: unknown }>(bytes)
  if (decoded.version !== 1) {
    throw new Error(`CAR: unsupported version ${String(decoded.version)} (expected 1)`)
  }
  if (!Array.isArray(decoded.roots) || decoded.roots.some((r) => !isCid(r))) {
    throw new Error('CAR: header roots must be an array of CIDs')
  }
  return { version: 1, roots: decoded.roots as CID[] }
}

function isCid(v: unknown): v is CID {
  return (
    typeof v === 'object' &&
    v !== null &&
    'bytes' in v &&
    'multihash' in v &&
    'code' in v
  )
}

/** Read a CID from the start of `bytes` and report how many bytes it spans.
 *
 *  📖 Shortcut: in our PDS every block is dag-cbor + sha2-256, so every CID
 *  is exactly 36 bytes (1 version + 1 codec + 1 hash code + 1 hash length +
 *  32 hash bytes). We fast-path that shape and fall back to a varint-walking
 *  parser for anything else — which is what we'd hit if we ingested CARs
 *  produced by a non-PDS tool. */
function parseCidPrefix(bytes: Uint8Array): { cid: CID; cidLen: number } {
  if (
    bytes.length >= 36 &&
    bytes[0] === 0x01 && // CIDv1
    bytes[1] === 0x71 && // codec = dag-cbor
    bytes[2] === 0x12 && // hash function = sha2-256
    bytes[3] === 0x20 // hash length = 32 bytes
  ) {
    const slice = bytes.subarray(0, 36)
    return { cid: CID.decode(slice), cidLen: 36 }
  }
  return parseCidGeneric(bytes)
}

function parseCidGeneric(bytes: Uint8Array): { cid: CID; cidLen: number } {
  // CIDv1: version || codec || multihash(code || size || digest).
  let offset = 0
  const version = readVarintFrom(bytes, offset)
  offset += version.size
  if (version.value !== 1) {
    throw new Error(`CAR: unsupported CID version ${version.value}`)
  }
  const codec = readVarintFrom(bytes, offset)
  offset += codec.size
  const hashCode = readVarintFrom(bytes, offset)
  offset += hashCode.size
  const hashSize = readVarintFrom(bytes, offset)
  offset += hashSize.size
  const end = offset + hashSize.value
  if (end > bytes.length) {
    throw new Error('CAR: CID multihash extends past block boundary')
  }
  const cid = CID.decode(bytes.subarray(0, end))
  return { cid, cidLen: end }
}

async function verifyHash(cid: CID, bytes: Uint8Array): Promise<void> {
  // We currently only ever produce sha2-256. Verify when we recognize the
  // hash function; otherwise refuse — trusting bytes-without-verification
  // would defeat the point of streaming a content-addressed format.
  if (cid.multihash.code !== sha256.code) {
    throw new Error(
      `CAR: unsupported multihash code 0x${cid.multihash.code.toString(16)}`,
    )
  }
  const actual = await sha256.digest(bytes)
  const expected = cid.multihash.bytes
  if (actual.bytes.length !== expected.length) {
    throw new Error('CAR: block hash length mismatch')
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual.bytes[i] !== expected[i]) {
      throw new Error(`CAR: block bytes do not hash to declared CID ${cid.toString()}`)
    }
  }
}

// --- byte-stream plumbing -------------------------------------------------

/** Buffers an async iterable of `Uint8Array` into a position-based reader.
 *  Exposes `readVarint`, `readExact(n)`, and `atEnd()` — exactly what the
 *  CAR parser needs and nothing more. */
class ChunkReader {
  private iter: AsyncIterator<Uint8Array>
  private buf: Uint8Array = new Uint8Array(0)
  private done = false

  constructor(source: AsyncIterable<Uint8Array> | Uint8Array) {
    if (source instanceof Uint8Array) {
      this.iter = singleChunk(source)
    } else {
      this.iter = source[Symbol.asyncIterator]()
    }
  }

  async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.pull())) {
        throw new Error(`CAR: unexpected EOF (wanted ${n} bytes, have ${this.buf.length})`)
      }
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /** Read an unsigned LEB128 varint from the stream. */
  async readVarint(): Promise<number> {
    let value = 0
    let shift = 1
    let i = 0
    while (true) {
      while (i >= this.buf.length) {
        if (!(await this.pull())) {
          throw new Error('CAR: unexpected EOF inside varint')
        }
      }
      const byte = this.buf[i]!
      i++
      value += (byte & 0x7f) * shift
      if ((byte & 0x80) === 0) {
        this.buf = this.buf.subarray(i)
        if (value > Number.MAX_SAFE_INTEGER) {
          throw new Error('CAR: varint exceeds JS safe integer')
        }
        return value
      }
      shift *= 128
      if (shift > Number.MAX_SAFE_INTEGER) {
        throw new Error('CAR: varint exceeds JS safe integer')
      }
    }
  }

  async atEnd(): Promise<boolean> {
    while (this.buf.length === 0) {
      if (!(await this.pull())) return true
    }
    return false
  }

  private async pull(): Promise<boolean> {
    if (this.done) return false
    const next = await this.iter.next()
    if (next.done) {
      this.done = true
      return false
    }
    const chunk = next.value
    if (chunk.length === 0) return this.pull()
    if (this.buf.length === 0) {
      this.buf = chunk
    } else {
      const merged = new Uint8Array(this.buf.length + chunk.length)
      merged.set(this.buf, 0)
      merged.set(chunk, this.buf.length)
      this.buf = merged
    }
    return true
  }
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

function readVarintFrom(
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
    if ((byte & 0x80) === 0) {
      if (value > Number.MAX_SAFE_INTEGER) {
        throw new Error('CAR: varint exceeds JS safe integer')
      }
      return { value, size: i - start }
    }
    shift *= 128
  }
  throw new Error('CAR: varint truncated')
}

// --- self-test ------------------------------------------------------------

/** Round-trip a tiny CAR (1 root, 3 blocks) end-to-end. Exported so the
 *  chapter's "Try it" section can call it without a test harness. Throws on
 *  any mismatch; resolves silently on success. */
export async function runCarSelfTest(): Promise<void> {
  const { encode: cborEncode } = await import('~/pds/codec')
  const { encodeCar } = await import('./encode')
  const blocks = await Promise.all([
    cborEncode({ note: 'leaf-a' }),
    cborEncode({ note: 'leaf-b' }),
    cborEncode({ root: true, children: ['a', 'b'] }),
  ])
  const root = blocks[2]!.cid
  const carBytes = await encodeCar({ roots: [root], blocks })
  const { header, blocks: out } = await decodeCar(carBytes)
  if (header.roots.length !== 1 || !header.roots[0]!.equals(root)) {
    throw new Error('self-test: header root mismatch')
  }
  if (out.length !== 3) {
    throw new Error(`self-test: expected 3 blocks, got ${out.length}`)
  }
  for (let i = 0; i < blocks.length; i++) {
    if (!out[i]!.cid.equals(blocks[i]!.cid)) {
      throw new Error(`self-test: block ${i} cid mismatch`)
    }
  }
}
