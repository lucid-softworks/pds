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
// See chapter 12 — Account creation.

import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, plcOperations } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import { generateKeypair } from '~/pds/repo/keys'
import { createGenesisRepo } from '~/pds/repo/repo'
import {
  assertValidHandle,
  isReservedTld,
  InvalidHandleError,
} from '~/pds/did/handle'
import { createLocalPlc } from '~/pds/did/plc'
import { hashPassword } from '~/pds/auth/password'
import { createSessionTokens } from '~/pds/auth/session'
import { emitIdentity, emitAccount } from '~/pds/sequencer/sequence'
import { buildDidDocument, type DidDocument } from '~/pds/did/document'
import { BadRequest, Conflict, XrpcError } from '~/pds/xrpc/errors'

export type CreateAccountInput = {
  handle: string
  email: string
  password: string
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

  // ── 3. Generate keys ───────────────────────────────────────────────────
  const signingKey = generateKeypair()
  const rotationKey = generateKeypair()

  // ── 4. Build + sign the genesis PLC op locally, derive the DID ─────────
  const cfg = getConfig()
  const { did } = await createLocalPlc({
    handle: input.handle,
    rotationKeyPriv: rotationKey.privateKeyHex,
    rotationKeyDidKey: rotationKey.didKey,
    signingKeyDidKey: signingKey.didKey,
    pdsEndpoint: cfg.publicUrl,
  })

  try {
    // ── 5. Hash password ─────────────────────────────────────────────────
    const passwordHash = await hashPassword(input.password)

    // ── 6. Insert account row ────────────────────────────────────────────
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
