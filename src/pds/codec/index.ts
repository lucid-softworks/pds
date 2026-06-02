// CIDs + DAG-CBOR — the universal block-addressing scheme for the PDS.
//
// Every block on the wire and in the database is DAG-CBOR bytes, identified
// by a CIDv1 wrapping (codec=dag-cbor, hash=sha2-256). See chapter 05.
//
// We wrap @ipld/dag-cbor (deterministic encode/decode) and multiformats (CID
// + multihash + multibase) with a tiny ergonomic API the rest of the code
// uses everywhere.

import * as dagCbor from '@ipld/dag-cbor'
import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'

export { CID }

export type Block = {
  cid: CID
  bytes: Uint8Array
}

/** Encode a value to DAG-CBOR and produce its content-addressed CID. */
export async function encode(value: unknown): Promise<Block> {
  const bytes = dagCbor.encode(value)
  const hash = await sha256.digest(bytes)
  return { bytes, cid: CID.createV1(dagCbor.code, hash) }
}

/** Decode DAG-CBOR bytes. If `expectedCid` is provided, verify first. */
export async function decode<T = unknown>(
  bytes: Uint8Array,
  expectedCid?: CID,
): Promise<T> {
  if (expectedCid) {
    const hash = await sha256.digest(bytes)
    const expected = expectedCid.multihash.bytes
    if (
      hash.bytes.length !== expected.length ||
      !hash.bytes.every((b, i) => b === expected[i])
    ) {
      throw new Error('CID mismatch: bytes do not hash to expected CID')
    }
  }
  return dagCbor.decode<T>(bytes)
}

/** CID for already-encoded DAG-CBOR bytes, without keeping the value around. */
export async function cidForBytes(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes)
  return CID.createV1(dagCbor.code, hash)
}

/** Parse a string CID (multibase-encoded). */
export function parseCid(s: string): CID {
  return CID.parse(s)
}

/** Compare two CIDs for equality. */
export function cidEquals(a: CID, b: CID): boolean {
  return a.equals(b)
}
