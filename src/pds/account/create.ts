// Account creation orchestration.
//
// One function — `createAccount` — drives the whole "register a new user"
// flow. It:
//   1. Validates input (handle syntax, password length, no collisions).
//   2. Generates a signing keypair and a rotation keypair.
//   3. Builds and locally signs the genesis PLC operation, deriving the DID.
//   4. Hashes the password.
//   5. Inserts the account row.
//   6. Creates the empty signed repo commit and persists its blocks.
//   7. Issues an access + refresh JWT pair.
//
// Steps 5–7 happen inside the same Drizzle context but not (yet) wrapped in
// a single transaction — that lands when we promote the high-level write
// flow in the records chapter. For now, if any step fails after the PLC op
// is generated, we attempt a best-effort cleanup.
//
// When `input.did` is set, this function instead drives the *migrating-in*
// flow: it adopts the caller-supplied DID, consumes a previously-reserved
// signing key, persists the caller's signed PLC rotate op as the local
// genesis, and inserts the account in a `deactivated` / `migrating-in`
// state. The repo itself lands later via `importRepo`. See chapter 20 —
// Migration.
//
// See chapter 12 — Account creation.

import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, plcOperations, reservedKeys } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import { generateKeypair } from '~/pds/repo/keys'
import { createGenesisRepo } from '~/pds/repo/repo'
import {
  assertValidHandle,
  isReservedTld,
  InvalidHandleError,
} from '~/pds/did/handle'
import { buildGenesisPlc, persistGenesisPlc } from '~/pds/did/plc'
import { publishPlcOp } from '~/pds/did/plc_client'
import { encode } from '~/pds/codec'
import { hashPassword } from '~/pds/auth/password'
import { createSessionTokens } from '~/pds/auth/session'
import { emitIdentity, emitAccount } from '~/pds/sequencer/sequence'
import { buildDidDocument, type DidDocument } from '~/pds/did/document'
import { BadRequest, Conflict, Unauthorized } from '~/pds/xrpc/errors'
import { peekInviteCode, reserveInviteCode } from './invites'

export type CreateAccountInput = {
  handle: string
  email: string
  password: string
  inviteCode?: string
  // ── Migration fields (presence indicates a migrating-in account). ──
  did?: string // pre-existing DID; we skip server-side derivation
  plcOp?: unknown // caller-supplied signed PLC op as JSON
}

export type CreateAccountResult = {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
  didDoc: DidDocument
}

export async function createAccount(
  input: CreateAccountInput,
): Promise<CreateAccountResult> {
  // ── 1. Validate ────────────────────────────────────────────────────────
  validateInput(input)

  // ── 2. Check uniqueness ────────────────────────────────────────────────
  await assertNotTaken(input.handle, input.email)

  // ── 2b. Invite-code pre-flight ─────────────────────────────────────────
  //
  // We split the invite check in two: a non-mutating *peek* now, and the
  // decrement+audit *reserve* after the account row is in. The DID isn't
  // known until step 4 in the fresh-account branch, so we can't enforce a
  // `forAccount` recipient gate here — that check runs again under
  // `reserveInviteCode` once we have a DID. The peek catches the common
  // failures (unknown / disabled / exhausted) before we burn a PLC op.
  //
  // Migrating-in accounts pay the same toll: a private PDS still requires an
  // invite to receive a transfer.
  const cfg = getConfig()
  if (cfg.inviteRequired) {
    if (!input.inviteCode) {
      throw Unauthorized('invite code required', 'InvalidInviteCode')
    }
    await peekInviteCode({
      code: input.inviteCode,
      candidateDid: input.did ?? null,
    })
  }

  // Branch: a caller-supplied DID means this is a migrating-in account.
  if (input.did !== undefined) {
    return createMigratingAccount(input, input.did)
  }

  // ── 3. Generate keys ───────────────────────────────────────────────────
  const signingKey = generateKeypair()
  const rotationKey = generateKeypair()

  // ── 4. Build + sign the genesis PLC op IN MEMORY. We derive the DID from
  //      the signed bytes, but we hold off on the plc_operations INSERT until
  //      the accounts row is in — plc_operations.did has an immediate FK to
  //      accounts.did and would otherwise reject. The op is signed and the
  //      DID is final at this point regardless of when it gets persisted.
  const plc = await buildGenesisPlc({
    handle: input.handle,
    rotationKeyPriv: rotationKey.privateKeyHex,
    rotationKeyDidKey: rotationKey.didKey,
    signingKeyDidKey: signingKey.didKey,
    pdsEndpoint: cfg.publicUrl,
  })
  const did = plc.did

  try {
    // ── 5. Hash password ─────────────────────────────────────────────────
    const passwordHash = await hashPassword(input.password)

    // ── 6. Insert account row FIRST. Once this lands the FK in
    //      plc_operations is satisfied, so step 6c can write the PLC log.
    await db.insert(accounts).values({
      did,
      handle: input.handle,
      email: input.email,
      passwordHash,
      signingKeyPriv: signingKey.privateKeyHex,
      signingKeyPub: signingKey.publicKeyMultibase,
      rotationKeyPriv: rotationKey.privateKeyHex,
      rotationKeyPub: rotationKey.publicKeyMultibase,
    })

    // ── 6a. Persist the genesis PLC op (FK now satisfied).
    await persistGenesisPlc({ did, signedBlock: plc.signedBlock })

    // ── 6a'. Publish to plc.directory. No-op in local-PLC mode. If this
    //         throws, the outer catch rolls back the account + plc rows.
    await publishPlcOp({ did, signedOpBytes: plc.signedOpBytes })

    // ── 6b. Consume the invite code ─────────────────────────────────────
    // Done after the account row lands so that the audit log can name a
    // real DID and so we never decrement a code on a signup that failed at
    // INSERT. If this throws (e.g. a racer drained the last use between
    // peek and now), the outer catch rolls back the account and PLC op.
    if (cfg.inviteRequired && input.inviteCode) {
      await reserveInviteCode({ code: input.inviteCode, usedBy: did })
    }

    // ── 7. Create the empty signed repo ──────────────────────────────────
    await createGenesisRepo({
      did,
      signingKeyPriv: signingKey.privateKeyHex,
    })

    // ── 7b. Announce the account on the firehose. Identity then account so
    //        consumers see the handle binding before they see status.
    await emitIdentity({ did, handle: input.handle })
    await emitAccount({ did, active: true })

    // ── 8. Issue session ─────────────────────────────────────────────────
    const tokens = await createSessionTokens(did)

    const didDoc = buildDidDocument({
      did,
      handle: input.handle,
      signingKeyMultibase: signingKey.publicKeyMultibase,
      pdsEndpoint: cfg.publicUrl,
    })

    return {
      did,
      handle: input.handle,
      ...tokens,
      didDoc,
    }
  } catch (err) {
    // Roll back the PLC op so the DID isn't a zombie. We don't try to undo
    // partial repo state — the FK cascade on `accounts` deletion takes care
    // of `repos` and `repo_blocks` if the account insert succeeded but a
    // later step failed.
    await db.delete(accounts).where(eq(accounts.did, did)).catch(() => {})
    await db.delete(plcOperations).where(eq(plcOperations.did, did)).catch(
      () => {},
    )
    throw err
  }
}

// ─── Migrating-in branch ─────────────────────────────────────────────────
//
// Bluesky's migration flow has the user (a) reserve a signing key on the
// destination, (b) build + sign a PLC rotate op that points
// `verificationMethods.atproto` at that key and `services.atproto_pds`
// at the destination, and (c) hand both the DID and the signed op to
// `createAccount`. We adopt the DID, consume the reservation, persist the
// op as the local PLC genesis (seq=0 — we don't carry the upstream chain
// across PDSes in local-PLC mode), and park the account in `deactivated`
// state. The actual repository lands later through `importRepo`, which
// flips the status to `active` once everything's verified.
async function createMigratingAccount(
  input: CreateAccountInput,
  did: string,
): Promise<CreateAccountResult> {
  const cfg = getConfig()

  if (!/^did:plc:[a-z2-7]{24}$/.test(did)) {
    throw BadRequest(
      'did must be a did:plc identifier',
      'UnsupportedDidMethod',
    )
  }

  const existing = await db
    .select({ did: accounts.did })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  if (existing[0]) {
    throw Conflict(`account already exists for ${did}`, 'AccountAlreadyExists')
  }

  const reservedRows = await db
    .select()
    .from(reservedKeys)
    .where(eq(reservedKeys.did, did))
    .limit(1)
  const reserved = reservedRows[0]
  if (!reserved) {
    throw BadRequest(
      `no signing key reserved for ${did} — call reserveSigningKey first`,
      'MissingReservedKey',
    )
  }
  const reservedDidKey = 'did:key:' + reserved.signingKeyPub

  // Structural + cross-field validation of the caller-supplied PLC op. We
  // *don't* verify the signature against the previous op's rotation key —
  // that would require a working plc.directory client (or the upstream
  // PDS shipping us the prior chain). Documented in chapter 20.
  const plcOp = validatePlcOp(input.plcOp, {
    handle: input.handle,
    expectedSigningDidKey: reservedDidKey,
    expectedServiceEndpoint: cfg.publicUrl,
  })

  // Pre-compute everything that can throw before we touch the database.
  const passwordHash = await hashPassword(input.password)
  const opBlock = await encode(plcOp)

  try {
    await db.insert(accounts).values({
      did,
      handle: input.handle,
      email: input.email,
      passwordHash,
      signingKeyPriv: reserved.signingKeyPriv,
      signingKeyPub: reserved.signingKeyPub,
      // The user keeps custody of the rotation key in a migration. We have
      // no copy of theirs — and won't, since the destination must never be
      // able to rotate the DID out from under the user. Persist an empty
      // string as a "no rotation key on this side" sentinel; the columns
      // are NOT NULL but the migration spec says we never use them on the
      // destination. A future schema bump should make these nullable.
      rotationKeyPriv: '',
      rotationKeyPub: '',
      status: 'deactivated',
      migrationState: 'migrating-in',
    })

    if (cfg.inviteRequired && input.inviteCode) {
      await reserveInviteCode({ code: input.inviteCode, usedBy: did })
    }

    // Persist the caller's signed op as the local genesis. We DAG-CBOR-encode
    // the JSON-shaped op canonically here so the stored bytes match what a
    // downstream reader would re-encode it to.
    await db.insert(plcOperations).values({
      did,
      cid: opBlock.cid.toString(),
      operation: opBlock.bytes,
      seq: 0,
    })

    // Consume the reservation. The private half is now on the account row.
    await db.delete(reservedKeys).where(eq(reservedKeys.did, did))

    // No genesis repo: importRepo will populate `repos` + `repo_blocks`.
    // Announce identity now so consumers know the handle binding; the
    // account event flags `active: false` until activateAccount runs.
    await emitIdentity({ did, handle: input.handle })
    await emitAccount({ did, active: false, status: 'deactivated' })

    const tokens = await createSessionTokens(did)

    const didDoc = buildDidDocument({
      did,
      handle: input.handle,
      signingKeyMultibase: reserved.signingKeyPub,
      pdsEndpoint: cfg.publicUrl,
    })

    return {
      did,
      handle: input.handle,
      ...tokens,
      didDoc,
    }
  } catch (err) {
    // Best-effort rollback. We don't restore the reserved row — if the
    // delete already ran, the user should re-call reserveSigningKey to get
    // a fresh reservation before retrying.
    await db.delete(accounts).where(eq(accounts.did, did)).catch(() => {})
    await db
      .delete(plcOperations)
      .where(eq(plcOperations.did, did))
      .catch(() => {})
    throw err
  }
}

type ValidatedPlcOp = {
  type: 'plc_operation'
  rotationKeys: string[]
  verificationMethods: Record<string, string>
  alsoKnownAs: string[]
  services: Record<string, { type: string; endpoint: string }>
  prev: string
  sig: string
}

function validatePlcOp(
  raw: unknown,
  expect: {
    handle: string
    expectedSigningDidKey: string
    expectedServiceEndpoint: string
  },
): ValidatedPlcOp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw BadRequest('plcOp is required and must be an object', 'InvalidRequest')
  }
  const op = raw as Record<string, unknown>

  if (op.type !== 'plc_operation') {
    throw BadRequest(
      "plcOp.type must be 'plc_operation'",
      'IncompatibleDidDoc',
    )
  }

  if (typeof op.sig !== 'string' || op.sig.length === 0) {
    throw BadRequest('plcOp.sig is required', 'IncompatibleDidDoc')
  }

  // Rotate ops chain; `prev` must reference the previous op's CID. The
  // genesis branch has `prev: null`, but a migrating-in op is by definition
  // a rotation.
  if (typeof op.prev !== 'string' || op.prev.length === 0) {
    throw BadRequest(
      'plcOp.prev must be the previous op CID (migrations are rotate ops)',
      'IncompatibleDidDoc',
    )
  }

  const rotationKeys = op.rotationKeys
  if (
    !Array.isArray(rotationKeys) ||
    rotationKeys.length === 0 ||
    !rotationKeys.every((k) => typeof k === 'string')
  ) {
    throw BadRequest(
      'plcOp.rotationKeys must be a non-empty string array',
      'IncompatibleDidDoc',
    )
  }

  const verificationMethods = op.verificationMethods
  if (
    !verificationMethods ||
    typeof verificationMethods !== 'object' ||
    Array.isArray(verificationMethods)
  ) {
    throw BadRequest(
      'plcOp.verificationMethods must be an object',
      'IncompatibleDidDoc',
    )
  }
  const vmAtproto = (verificationMethods as Record<string, unknown>).atproto
  if (typeof vmAtproto !== 'string') {
    throw BadRequest(
      'plcOp.verificationMethods.atproto is required',
      'IncompatibleDidDoc',
    )
  }
  if (vmAtproto !== expect.expectedSigningDidKey) {
    throw BadRequest(
      `plcOp.verificationMethods.atproto must equal the reserved signing key (${expect.expectedSigningDidKey})`,
      'MismatchedSigningKey',
    )
  }

  const services = op.services
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw BadRequest('plcOp.services must be an object', 'IncompatibleDidDoc')
  }
  const pdsService = (services as Record<string, unknown>).atproto_pds
  if (!pdsService || typeof pdsService !== 'object' || Array.isArray(pdsService)) {
    throw BadRequest(
      'plcOp.services.atproto_pds must be an object',
      'IncompatibleDidDoc',
    )
  }
  const svc = pdsService as Record<string, unknown>
  if (svc.type !== 'AtprotoPersonalDataServer') {
    throw BadRequest(
      "plcOp.services.atproto_pds.type must be 'AtprotoPersonalDataServer'",
      'IncompatibleDidDoc',
    )
  }
  if (typeof svc.endpoint !== 'string') {
    throw BadRequest(
      'plcOp.services.atproto_pds.endpoint must be a string',
      'IncompatibleDidDoc',
    )
  }
  if (svc.endpoint.replace(/\/$/, '') !== expect.expectedServiceEndpoint) {
    throw BadRequest(
      `plcOp.services.atproto_pds.endpoint must equal ${expect.expectedServiceEndpoint}`,
      'MismatchedServiceEndpoint',
    )
  }

  const alsoKnownAs = op.alsoKnownAs
  if (
    !Array.isArray(alsoKnownAs) ||
    alsoKnownAs.length === 0 ||
    !alsoKnownAs.every((a) => typeof a === 'string')
  ) {
    throw BadRequest(
      'plcOp.alsoKnownAs must be a non-empty string array',
      'IncompatibleDidDoc',
    )
  }
  if (alsoKnownAs[0] !== `at://${expect.handle}`) {
    throw BadRequest(
      `plcOp.alsoKnownAs[0] must be at://${expect.handle}`,
      'IncompatibleDidDoc',
    )
  }

  return {
    type: 'plc_operation',
    rotationKeys: rotationKeys as string[],
    verificationMethods: verificationMethods as Record<string, string>,
    alsoKnownAs: alsoKnownAs as string[],
    services: services as Record<string, { type: string; endpoint: string }>,
    prev: op.prev,
    sig: op.sig,
  }
}

function validateInput(input: CreateAccountInput): void {
  if (!input.handle) throw BadRequest('handle is required')
  try {
    assertValidHandle(input.handle)
  } catch (err: unknown) {
    if (err instanceof InvalidHandleError) {
      throw BadRequest(err.message, 'InvalidHandle')
    }
    throw err
  }
  if (isReservedTld(input.handle)) {
    // Allowed in dev (e.g. alice.test); we log so it's visible.
    console.warn(`[createAccount] handle uses reserved TLD: ${input.handle}`)
  }
  if (!input.email) throw BadRequest('email is required')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    throw BadRequest('email is not a valid address', 'InvalidEmail')
  }
  if (!input.password) throw BadRequest('password is required')
  if (input.password.length < 8) {
    throw BadRequest('password must be at least 8 characters', 'InvalidPassword')
  }
}

async function assertNotTaken(handle: string, email: string): Promise<void> {
  const byHandle = await db
    .select({ did: accounts.did })
    .from(accounts)
    .where(eq(accounts.handle, handle))
    .limit(1)
  if (byHandle[0]) throw Conflict(`handle taken: ${handle}`, 'HandleNotAvailable')
  const byEmail = await db
    .select({ did: accounts.did })
    .from(accounts)
    .where(eq(accounts.email, email))
    .limit(1)
  if (byEmail[0]) throw Conflict(`email already registered`, 'EmailNotAvailable')
}
