// Repository commits — build, sign, verify.
//
// A commit is a small CBOR record naming the MST root for the repo at a
// given revision, signed by the account's repo signing key. See chapter 07.
//
// Shape (v3 of the repo format):
//   { did, version: 3, data: <MST root CID>, rev: <TID>, prev: null, sig: bytes }
//
// We build the *unsigned* commit, DAG-CBOR encode it, hash with SHA-256, sign
// the hash with secp256k1, then re-encode the commit with `sig` attached.

import { encode, decode, type Block, type CID } from '~/pds/codec'
import { signBytes, verifyBytes } from './keys'

export type UnsignedCommit = {
  did: string
  version: 3
  data: CID
  rev: string
  prev: null
}

export type SignedCommit = UnsignedCommit & {
  sig: Uint8Array
}

export async function buildSignedCommit(args: {
  did: string
  data: CID
  rev: string
  signingKeyPriv: string
}): Promise<Block> {
  const unsigned: UnsignedCommit = {
    did: args.did,
    version: 3,
    data: args.data,
    rev: args.rev,
    prev: null,
  }
  // Encode the unsigned commit deterministically and sign those bytes.
  const unsignedBlock = await encode(unsigned)
  const sig = signBytes(args.signingKeyPriv, unsignedBlock.bytes)
  const signed: SignedCommit = { ...unsigned, sig }
  return await encode(signed)
}

/** Verify a signed commit's signature against a public key. The commit must
 *  be canonical DAG-CBOR (which by construction ours are). */
export async function verifyCommit(
  signedCommitBytes: Uint8Array,
  publicKeyMultibase: string,
): Promise<boolean> {
  const signed = await decode<SignedCommit>(signedCommitBytes)
  const { sig, ...unsigned } = signed
  if (!sig || !(sig instanceof Uint8Array)) return false
  const unsignedBlock = await encode(unsigned)
  return verifyBytes(publicKeyMultibase, unsignedBlock.bytes, sig)
}

export async function decodeCommit(bytes: Uint8Array): Promise<SignedCommit> {
  return await decode<SignedCommit>(bytes)
}
