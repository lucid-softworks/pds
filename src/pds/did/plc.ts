// did:plc creation, the "local PLC" variant.
//
// In production, the genesis operation is POSTed to plc.directory, which
// derives the DID from the operation's hash and stores it in an append-only
// log keyed by the DID. The directory is the authoritative resolver for the
// did:plc method.
//
// In this teaching port we generate the same shape of operation, sign it
// with the same algorithm, and derive the DID by the same hash — we just
// don't publish to the directory. The operation is stored in the local
// `plc_operations` table; resolution for our own DIDs reads from there.
//
// See chapter 12 — Account creation, and the diff-from-upstream callout in
// chapter 04.

import { sha256 } from '@noble/hashes/sha256'
import { base32 } from 'multiformats/bases/base32'
import { encode } from '~/pds/codec'
import { signBytes } from '~/pds/repo/keys'
import { db } from '~/lib/db'
import { plcOperations } from '~/lib/db/schema'

// Unsigned form. Bluesky's PLC spec uses snake_case in operation field names;
// the `sig` field is appended after signing.
export type UnsignedPlcOp = {
  type: 'plc_operation'
  rotationKeys: string[] // did:key entries
  verificationMethods: Record<string, string> // { atproto: 'did:key:...' }
  alsoKnownAs: string[] // ['at://alice.test']
  services: Record<
    string,
    { type: string; endpoint: string }
  >
  prev: string | null
}

export type SignedPlcOp = UnsignedPlcOp & {
  sig: string // base64url(64-byte compact secp256k1 signature)
}

export type GenesisInput = {
  handle: string
  rotationKeyPriv: string
  rotationKeyDidKey: string
  signingKeyDidKey: string
  pdsEndpoint: string
}

export type GenesisResult = {
  did: string
  signedOp: SignedPlcOp
  signedOpBytes: Uint8Array
}

/** Build, sign, and locally persist a genesis PLC operation. Returns the
 *  resulting DID. */
export async function createLocalPlc(
  input: GenesisInput,
): Promise<GenesisResult> {
  const unsigned: UnsignedPlcOp = {
    type: 'plc_operation',
    rotationKeys: [input.rotationKeyDidKey],
    verificationMethods: { atproto: input.signingKeyDidKey },
    alsoKnownAs: [`at://${input.handle}`],
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: input.pdsEndpoint,
      },
    },
    prev: null,
  }

  // Sign the DAG-CBOR encoding of the *unsigned* op with the rotation key.
  const unsignedBlock = await encode(unsigned)
  const sigBytes = signBytes(input.rotationKeyPriv, unsignedBlock.bytes)
  const signed: SignedPlcOp = { ...unsigned, sig: base64url(sigBytes) }

  // The DID is derived from the SHA-256 of the *signed* op's DAG-CBOR bytes,
  // base32-encoded (lowercase, no padding), truncated to 24 characters.
  const signedBlock = await encode(signed)
  const hash = sha256(signedBlock.bytes)
  const did = 'did:plc:' + base32.baseEncode(hash).slice(0, 24)

  await db.insert(plcOperations).values({
    did,
    cid: signedBlock.cid.toString(),
    operation: signedBlock.bytes,
    seq: 0,
  })

  return { did, signedOp: signed, signedOpBytes: signedBlock.bytes }
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
