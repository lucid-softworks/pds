// CAR v1 encoder.
//
// A CAR is a one-shot envelope around (header, blocks):
//
//   varint(header_len) || dag-cbor({ version: 1, roots }) ||
//   ( varint(cid_bytes_len + block_bytes_len) || cid_bytes || block_bytes )*
//
// CIDs go on the wire in raw multihash form (no multibase prefix). See
// chapter 08 for the design rationale.

import { encode as cborEncode, type CID } from '~/pds/codec'

export type CarBlock = { cid: CID; bytes: Uint8Array }

export type CarInput = {
  roots: CID[]
  blocks: Iterable<CarBlock>
}

export type CarStreamInput = {
  roots: CID[]
  blocks: AsyncIterable<CarBlock> | Iterable<CarBlock>
}

/** Build the full CAR as a single Uint8Array. Convenient for small payloads
 *  like firehose commit diffs and tests; prefer `encodeCarChunks` for repos. */
export async function encodeCar(args: CarInput): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of encodeCarChunks(args)) {
    chunks.push(chunk)
  }
  return concat(chunks)
}

/** Streaming variant — yields the header chunk, then one chunk per block.
 *  The caller composes these into a ReadableStream or writes them straight to
 *  an HTTP response. */
export async function* encodeCarChunks(
  args: CarStreamInput,
): AsyncGenerator<Uint8Array> {
  yield await encodeHeader(args.roots)
  for await (const block of toAsyncIterable(args.blocks)) {
    yield encodeBlock(block)
  }
}

async function encodeHeader(roots: CID[]): Promise<Uint8Array> {
  // The header is a tiny DAG-CBOR map. We don't address it by CID — only its
  // length-prefixed bytes go on the wire — so we call dagCbor directly via
  // the codec module's encode (which also computes a CID we then discard).
  const headerBlock = await cborEncode({ version: 1, roots })
  const lenPrefix = encodeVarint(headerBlock.bytes.length)
  const out = new Uint8Array(lenPrefix.length + headerBlock.bytes.length)
  out.set(lenPrefix, 0)
  out.set(headerBlock.bytes, lenPrefix.length)
  return out
}

function encodeBlock(block: CarBlock): Uint8Array {
  const cidBytes = block.cid.bytes
  const bodyLen = cidBytes.length + block.bytes.length
  const lenPrefix = encodeVarint(bodyLen)
  const out = new Uint8Array(lenPrefix.length + bodyLen)
  out.set(lenPrefix, 0)
  out.set(cidBytes, lenPrefix.length)
  out.set(block.bytes, lenPrefix.length + cidBytes.length)
  return out
}

/** Unsigned LEB128 varint. 7 payload bits per byte, high bit = "more to come".
 *  CAR lengths fit comfortably in 53 bits (JS safe-integer ceiling). */
export function encodeVarint(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`varint: not a non-negative integer: ${n}`)
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`varint: exceeds JS safe integer: ${n}`)
  }
  // Worst case (2^53) is 8 bytes. Allocate 10 for headroom (matches LEB128
  // worst-case for full 64-bit values, which we still reject above).
  const buf = new Uint8Array(10)
  let i = 0
  let v = n
  while (v >= 0x80) {
    buf[i++] = (v & 0x7f) | 0x80
    // Math.floor(v / 128) avoids the 32-bit truncation of `>>> 7`.
    v = Math.floor(v / 128)
  }
  buf[i++] = v & 0x7f
  return buf.subarray(0, i)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

async function* toAsyncIterable<T>(
  source: AsyncIterable<T> | Iterable<T>,
): AsyncGenerator<T> {
  if (Symbol.asyncIterator in source) {
    for await (const item of source as AsyncIterable<T>) yield item
  } else {
    for (const item of source as Iterable<T>) yield item
  }
}
