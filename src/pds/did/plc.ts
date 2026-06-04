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

import { desc, eq } from 'drizzle-orm'
import { sha256 } from '@noble/hashes/sha256'
import { base32 } from 'multiformats/bases/base32'
import { decode, encode } from '~/pds/codec'
import { signBytes } from '~/pds/repo/keys'
import { db } from '~/lib/db'
import { plcOperations } from '~/lib/db/schema'
import { publishPlcOp } from './plc_client'

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

/** Build + sign a genesis PLC operation in memory. The DID is the hash of
 *  the signed bytes, so we can derive it without touching the database. The
 *  caller is expected to call `persistGenesisPlc` after the matching account
 *  row has been inserted — plc_operations.did → accounts.did is an FK that
 *  rejects unbacked PLC rows. */
export async function buildGenesisPlc(
  input: GenesisInput,
): Promise<GenesisResult & { signedBlock: { cid: string; bytes: Uint8Array } }> {
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

  return {
    did,
    signedOp: signed,
    signedOpBytes: signedBlock.bytes,
    signedBlock: {
      cid: signedBlock.cid.toString(),
      bytes: signedBlock.bytes,
    },
  }
}

/** Persist a genesis PLC op. Call AFTER the accounts row is inserted so the
 *  FK from plc_operations.did → accounts.did is satisfied. */
export async function persistGenesisPlc(args: {
  did: string
  signedBlock: { cid: string; bytes: Uint8Array }
}): Promise<void> {
  await db.insert(plcOperations).values({
    did: args.did,
    cid: args.signedBlock.cid,
    operation: args.signedBlock.bytes,
    seq: 0,
  })
}

/** Back-compat wrapper for the old name. Builds the op AND persists in one
 *  call — only safe when the caller already has an accounts row in place. */
export async function createLocalPlc(
  input: GenesisInput,
): Promise<GenesisResult> {
  const built = await buildGenesisPlc(input)
  await persistGenesisPlc({ did: built.did, signedBlock: built.signedBlock })
  return {
    did: built.did,
    signedOp: built.signedOp,
    signedOpBytes: built.signedOpBytes,
  }
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type RotateInput = {
  did: string
  /** New handle. If omitted, the previous op's handle is carried forward —
   *  useful once we extend rotations beyond handle changes. */
  newHandle?: string
  rotationKeyPriv: string
}

export type RotateResult = {
  cid: string
  seq: number
  signedOpBytes: Uint8Array
}

/** Append a "rotate" PLC operation to the local log. Chains `prev` to the
 *  current latest op's CID; keeps every other field identical unless an
 *  argument overrides it. Returns the new op's CID + seq for the caller —
 *  today only the handle can change, but the shape generalises to key /
 *  service rotation when those land. */
export async function rotatePlc(input: RotateInput): Promise<RotateResult> {
  // 1. Load the latest op for this DID.
  const latest = await loadLatestPlcOp(input.did)

  // 2. Build the unsigned op, carrying forward every field that isn't being
  //    overridden. `prev` is the only structural change vs the genesis.
  const newHandle =
    input.newHandle ?? handleFromAlsoKnownAs(latest.op.alsoKnownAs)
  const unsigned: UnsignedPlcOp = {
    type: 'plc_operation',
    rotationKeys: latest.op.rotationKeys,
    verificationMethods: latest.op.verificationMethods,
    alsoKnownAs: [`at://${newHandle}`],
    services: latest.op.services,
    prev: latest.cid,
  }

  // 3. Sign the unsigned encoding with the rotation key — same algorithm as
  //    the genesis op.
  const unsignedBlock = await encode(unsigned)
  const sigBytes = signBytes(input.rotationKeyPriv, unsignedBlock.bytes)
  const signed: SignedPlcOp = { ...unsigned, sig: base64url(sigBytes) }

  // 4. Encode the signed op; its CID is what the next rotation will chain to.
  const signedBlock = await encode(signed)
  const nextSeq = latest.seq + 1

  await db.insert(plcOperations).values({
    did: input.did,
    cid: signedBlock.cid.toString(),
    operation: signedBlock.bytes,
    seq: nextSeq,
  })

  // Publish to plc.directory. No-op in local-PLC mode. Same endpoint as the
  // genesis op — the directory ingests the whole chain at /<did>.
  await publishPlcOp({ did: input.did, signedOpBytes: signedBlock.bytes })

  return {
    cid: signedBlock.cid.toString(),
    seq: nextSeq,
    signedOpBytes: signedBlock.bytes,
  }
}

/** Rotate the DID's PLC op to advertise an `atproto_labeler` service
 *  entry pointing at the PDS's public URL. Idempotent: returns null if
 *  the entry is already present.
 *
 *  Called from the team-lead bootstrap (`src/pds/mod/team.ts`) the first
 *  time `getModTeamLead()` resolves the configured handle to an
 *  account. The genesis op only includes `atproto_pds`; AppViews fetch
 *  the canonical DID document from plc.directory, so without this
 *  rotation no one outside this PDS would know the team-lead is also a
 *  labeler. See chapter 24.
 *
 *  Returns the cid + seq of the new op when one was issued. */
export async function ensureLabelerService(input: {
  did: string
  rotationKeyPriv: string
  pdsEndpoint: string
}): Promise<{ cid: string; seq: number } | null> {
  const latest = await loadLatestPlcOp(input.did)
  if (latest.op.services.atproto_labeler) return null

  const unsigned: UnsignedPlcOp = {
    type: 'plc_operation',
    rotationKeys: latest.op.rotationKeys,
    verificationMethods: latest.op.verificationMethods,
    alsoKnownAs: latest.op.alsoKnownAs,
    services: {
      ...latest.op.services,
      atproto_labeler: {
        type: 'AtprotoLabeler',
        endpoint: input.pdsEndpoint,
      },
    },
    prev: latest.cid,
  }
  const unsignedBlock = await encode(unsigned)
  const sigBytes = signBytes(input.rotationKeyPriv, unsignedBlock.bytes)
  const signed: SignedPlcOp = { ...unsigned, sig: base64url(sigBytes) }
  const signedBlock = await encode(signed)
  const nextSeq = latest.seq + 1

  await db.insert(plcOperations).values({
    did: input.did,
    cid: signedBlock.cid.toString(),
    operation: signedBlock.bytes,
    seq: nextSeq,
  })
  await publishPlcOp({ did: input.did, signedOpBytes: signedBlock.bytes })

  return { cid: signedBlock.cid.toString(), seq: nextSeq }
}

/** Load the most recent PLC op for `did`. Exported because the
 *  `signPlcOperation` XRPC handler needs to forward unchanged fields from
 *  the latest op into a caller-supplied rotate op. */
export async function loadLatestPlcOp(did: string): Promise<{
  cid: string
  seq: number
  op: SignedPlcOp
}> {
  const rows = await db
    .select({
      cid: plcOperations.cid,
      seq: plcOperations.seq,
      operation: plcOperations.operation,
    })
    .from(plcOperations)
    .where(eq(plcOperations.did, did))
    .orderBy(desc(plcOperations.seq))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new Error(`no PLC operations for ${did}`)
  }
  const op = await decode<SignedPlcOp>(row.operation)
  return { cid: row.cid, seq: row.seq, op }
}

function handleFromAlsoKnownAs(aka: string[]): string {
  const first = aka[0]
  if (!first || !first.startsWith('at://')) {
    throw new Error(`alsoKnownAs[0] is not an at:// URI: ${first}`)
  }
  return first.slice('at://'.length)
}

/** End-to-end check that rotation produces a properly chained op. Useful
 *  during development; not part of the request path. Returns the two CIDs
 *  for inspection. */
export async function runPlcRotationSelfTest(): Promise<{
  genesisCid: string
  rotatedCid: string
  rotatedPrev: string | null
}> {
  const { generateKeypair } = await import('~/pds/repo/keys')
  const { getKeyWrapper } = await import('~/pds/auth/key_wrap')
  const signing = generateKeypair()
  const rotation = generateKeypair()
  const handle = `selftest-${Date.now()}.test`

  const genesis = await createLocalPlc({
    handle,
    rotationKeyPriv: rotation.privateKeyHex,
    rotationKeyDidKey: rotation.didKey,
    signingKeyDidKey: signing.didKey,
    pdsEndpoint: 'http://localhost:3000',
  })

  // Insert a stub account row so the FK on plc_operations passes. Private
  // keys go through the configured at-rest wrapper — see chapter 18.
  const wrapper = getKeyWrapper()
  const { accounts } = await import('~/lib/db/schema')
  await db.insert(accounts).values({
    did: genesis.did,
    handle,
    email: `${handle}@example.invalid`,
    passwordHash: 'selftest',
    signingKeyPriv: await wrapper.wrap(signing.privateKeyHex),
    signingKeyPub: signing.publicKeyMultibase,
    rotationKeyPriv: await wrapper.wrap(rotation.privateKeyHex),
    rotationKeyPub: rotation.publicKeyMultibase,
  })

  const rotated = await rotatePlc({
    did: genesis.did,
    newHandle: `renamed-${Date.now()}.test`,
    rotationKeyPriv: rotation.privateKeyHex,
  })

  const decoded = await decode<SignedPlcOp>(rotated.signedOpBytes)
  if (decoded.prev === null) {
    throw new Error('rotated op has null prev — chain broken')
  }
  // The exact check that matters: `prev` equals the genesis op's CID.
  const genesisBlock = await encode(genesis.signedOp)
  if (decoded.prev !== genesisBlock.cid.toString()) {
    throw new Error(
      `rotated.prev (${decoded.prev}) does not match genesis CID (${genesisBlock.cid})`,
    )
  }
  return {
    genesisCid: genesisBlock.cid.toString(),
    rotatedCid: rotated.cid,
    rotatedPrev: decoded.prev,
  }
}
