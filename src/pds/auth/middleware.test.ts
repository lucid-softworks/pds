// Behavior contract for the auth middleware.
//
// Three flavours of auth converge in this file:
//
//   - `requireAccessAuth` — legacy chapter-13 `Bearer <hs256-jwt>`.
//   - `requireOauthAccess` — chapter-21 `DPoP <es256k-jwt>` + `DPoP:` proof.
//   - `requireEitherAuth` — dispatcher entry point that picks between them.
//
// We use the real database (pglite) because the middleware loads accounts
// inside its happy path, and stubbing out the DB layer would just teach the
// tests to lie about reality. The OAuth signing key must be set BEFORE the
// `~/pds/oauth/keys` module is imported, so we mirror the same env-var-then-
// import dance the OAuth integration test uses.

import { setupTestDbEnv, migrateProcessDb } from '../../../tests/db'

setupTestDbEnv()
process.env.PDS_OAUTH_SIGNING_KEY ??=
  '2222222222222222222222222222222222222222222222222222222222222222'

import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint,
} from 'jose'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import { createAccount } from '~/pds/account/create'
import { signOauthAccessToken } from '~/pds/oauth/tokens'
import { signDpopProof, _resetDpopJtiCache } from '~/pds/oauth/dpop'
import { signAccessToken } from '~/pds/auth/jwt'
import { XrpcError } from '~/pds/xrpc/errors'
import {
  requireAccessAuth,
  requireEitherAuth,
  requireOauthAccess,
  requireScope,
} from './middleware'

// Caller helpers — make a Request, build OAuth credentials.
function mkRequest(method: string, url: string): Request {
  return new Request(url, { method })
}

async function expectXrpcError(
  fn: () => Promise<unknown>,
  status: number,
  errorName: string,
): Promise<void> {
  let caught: unknown
  try {
    await fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(XrpcError)
  const e = caught as XrpcError
  expect(e.status).toBe(status)
  expect(e.errorName).toBe(errorName)
}

beforeAll(async () => {
  await migrateProcessDb()
})

afterEach(() => {
  _resetDpopJtiCache()
})

describe('requireAccessAuth (legacy Bearer session JWT)', () => {
  const handle = `mw-bearer-${Date.now()}.example.com`
  const email = `mw-bearer-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string

  beforeAll(async () => {
    const acct = await createAccount({ handle, email, password })
    did = acct.did
  })

  it('throws AuthMissing when no header is provided', async () => {
    await expectXrpcError(() => requireAccessAuth(undefined), 401, 'AuthMissing')
  })

  it('returns the account for a valid Bearer JWT', async () => {
    const { jwt } = await signAccessToken(did)
    const me = await requireAccessAuth(`Bearer ${jwt}`)
    expect(me.did).toBe(did)
    expect(me.handle).toBe(handle)
    expect(me.email).toBe(email)
    expect(me.status).toBe('active')
  })

  it('throws ExpiredToken when the JWT is past its exp', async () => {
    const cfg = getConfig()
    const past = Math.floor(Date.now() / 1000) - 3600
    const expired = await new SignJWT({ scope: 'com.atproto.access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(cfg.serviceDid)
      .setAudience(cfg.serviceDid)
      .setSubject(did)
      .setJti('expired-mw')
      .setIssuedAt(past - 1)
      .setExpirationTime(past)
      .sign(cfg.jwtSecret)
    await expectXrpcError(
      () => requireAccessAuth(`Bearer ${expired}`),
      401,
      'ExpiredToken',
    )
  })

  it('throws InvalidToken on a junk Bearer payload', async () => {
    await expectXrpcError(
      () => requireAccessAuth('Bearer not-a-jwt'),
      401,
      'InvalidToken',
    )
  })

  it('throws AccountDeactivated for a deactivated account on default opts', async () => {
    // Build a second account, flip its status. The token still verifies but
    // the middleware must refuse.
    const h = `mw-deact-${Date.now()}.example.com`
    const e = `mw-deact-${Date.now()}@example.test`
    const acct = await createAccount({ handle: h, email: e, password })
    await db
      .update(accounts)
      .set({ status: 'deactivated' })
      .where(eq(accounts.did, acct.did))
    const { jwt } = await signAccessToken(acct.did)
    await expectXrpcError(
      () => requireAccessAuth(`Bearer ${jwt}`),
      403,
      'AccountDeactivated',
    )
  })

  it('returns the deactivated account when allowDeactivated is set', async () => {
    const h = `mw-deact-ok-${Date.now()}.example.com`
    const e = `mw-deact-ok-${Date.now()}@example.test`
    const acct = await createAccount({ handle: h, email: e, password })
    await db
      .update(accounts)
      .set({ status: 'deactivated' })
      .where(eq(accounts.did, acct.did))
    const { jwt } = await signAccessToken(acct.did)
    const me = await requireAccessAuth(`Bearer ${jwt}`, {
      allowDeactivated: true,
    })
    expect(me.did).toBe(acct.did)
    expect(me.status).toBe('deactivated')
  })
})

describe('requireOauthAccess (DPoP-bound OAuth access token)', () => {
  const handle = `mw-oauth-${Date.now()}.example.com`
  const email = `mw-oauth-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string

  beforeAll(async () => {
    const acct = await createAccount({ handle, email, password })
    did = acct.did
  })

  async function mintCredentials(opts?: {
    /** Pretend the access token's cnf.jkt is for a DIFFERENT key than the
     *  proof. */
    bindToWrongJkt?: boolean
    /** Expire the access token. */
    expired?: boolean
    scope?: string
  }): Promise<{ accessJwt: string; proof: string }> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    const publicJwk = await exportJWK(publicKey)
    const jkt = await calculateJwkThumbprint(publicJwk, 'sha256')
    const cnfJkt = opts?.bindToWrongJkt ? `${jkt.slice(0, -3)}xxx` : jkt
    const { jwt: accessJwt } = await signOauthAccessToken({
      did,
      scope: opts?.scope ?? 'atproto transition:generic',
      dpopJkt: cnfJkt,
      // Negative TTL backdates exp so jwtVerify throws ERR_JWT_EXPIRED.
      expiresInSeconds: opts?.expired ? -3600 : undefined,
    })
    const proof = await signDpopProof({
      publicJwk,
      privateKey,
      alg: 'ES256',
      httpMethod: 'GET',
      httpUri: 'http://localhost:3000/xrpc/com.atproto.server.getSession',
    })
    return { accessJwt, proof }
  }

  it('happy path: returns the account and granted scope', async () => {
    const { accessJwt, proof } = await mintCredentials()
    const req = mkRequest(
      'GET',
      'http://localhost:3000/xrpc/com.atproto.server.getSession',
    )
    const me = await requireOauthAccess({
      authorization: `DPoP ${accessJwt}`,
      dpopProof: proof,
      request: req,
    })
    expect(me.did).toBe(did)
    expect(me.scope).toBe('atproto transition:generic')
  })

  it('throws AuthMissing when the DPoP proof header is absent', async () => {
    const { accessJwt } = await mintCredentials()
    const req = mkRequest(
      'GET',
      'http://localhost:3000/xrpc/com.atproto.server.getSession',
    )
    await expectXrpcError(
      () =>
        requireOauthAccess({
          authorization: `DPoP ${accessJwt}`,
          dpopProof: undefined,
          request: req,
        }),
      401,
      'AuthMissing',
    )
  })

  it('throws InvalidToken when the proof key thumbprint != access cnf.jkt', async () => {
    const { accessJwt, proof } = await mintCredentials({ bindToWrongJkt: true })
    const req = mkRequest(
      'GET',
      'http://localhost:3000/xrpc/com.atproto.server.getSession',
    )
    await expectXrpcError(
      () =>
        requireOauthAccess({
          authorization: `DPoP ${accessJwt}`,
          dpopProof: proof,
          request: req,
        }),
      401,
      'InvalidToken',
    )
  })

  it('rejects when the proof was signed for a different htm', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    const publicJwk = await exportJWK(publicKey)
    const jkt = await calculateJwkThumbprint(publicJwk, 'sha256')
    const { jwt: accessJwt } = await signOauthAccessToken({
      did,
      scope: 'atproto',
      dpopJkt: jkt,
    })
    // Proof says POST, the live request is a GET — htm mismatch.
    const proof = await signDpopProof({
      publicJwk,
      privateKey,
      alg: 'ES256',
      httpMethod: 'POST',
      httpUri: 'http://localhost:3000/xrpc/com.atproto.server.getSession',
    })
    const req = mkRequest(
      'GET',
      'http://localhost:3000/xrpc/com.atproto.server.getSession',
    )
    await expectXrpcError(
      () =>
        requireOauthAccess({
          authorization: `DPoP ${accessJwt}`,
          dpopProof: proof,
          request: req,
        }),
      401,
      'InvalidToken',
    )
  })

  it('throws ExpiredToken when the access token is past exp', async () => {
    const { accessJwt, proof } = await mintCredentials({ expired: true })
    const req = mkRequest(
      'GET',
      'http://localhost:3000/xrpc/com.atproto.server.getSession',
    )
    await expectXrpcError(
      () =>
        requireOauthAccess({
          authorization: `DPoP ${accessJwt}`,
          dpopProof: proof,
          request: req,
        }),
      401,
      'ExpiredToken',
    )
  })
})

describe('requireEitherAuth (dispatcher entry)', () => {
  const handle = `mw-either-${Date.now()}.example.com`
  const email = `mw-either-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string

  beforeAll(async () => {
    const acct = await createAccount({ handle, email, password })
    did = acct.did
  })

  it('routes Bearer to the legacy flow (scope = session)', async () => {
    const { jwt } = await signAccessToken(did)
    const req = mkRequest('GET', 'http://localhost:3000/xrpc/whatever')
    const me = await requireEitherAuth({
      authorization: `Bearer ${jwt}`,
      dpopProof: undefined,
      request: req,
    })
    expect(me.did).toBe(did)
    expect(me.scope).toBe('session')
  })

  it('routes DPoP to the OAuth flow (scope from the token)', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    const publicJwk = await exportJWK(publicKey)
    const jkt = await calculateJwkThumbprint(publicJwk, 'sha256')
    const { jwt: accessJwt } = await signOauthAccessToken({
      did,
      scope: 'atproto',
      dpopJkt: jkt,
    })
    const url = 'http://localhost:3000/xrpc/com.atproto.server.getSession'
    const proof = await signDpopProof({
      publicJwk,
      privateKey,
      alg: 'ES256',
      httpMethod: 'GET',
      httpUri: url,
    })
    const me = await requireEitherAuth({
      authorization: `DPoP ${accessJwt}`,
      dpopProof: proof,
      request: mkRequest('GET', url),
    })
    expect(me.did).toBe(did)
    expect(me.scope).toBe('atproto')
  })

  it('throws InvalidToken on an unrecognised scheme', async () => {
    const req = mkRequest('GET', 'http://localhost:3000/xrpc/whatever')
    await expectXrpcError(
      () =>
        requireEitherAuth({
          authorization: 'Basic dXNlcjpwYXNz',
          dpopProof: undefined,
          request: req,
        }),
      401,
      'InvalidToken',
    )
  })

  it('throws AuthMissing when no header is provided', async () => {
    const req = mkRequest('GET', 'http://localhost:3000/xrpc/whatever')
    await expectXrpcError(
      () =>
        requireEitherAuth({
          authorization: undefined,
          dpopProof: undefined,
          request: req,
        }),
      401,
      'AuthMissing',
    )
  })
})

describe('requireScope (OAuth scope gating)', () => {
  // Build a minimal account stub — the real loadAccount path is exercised by
  // the suites above; this test set is purely about the scope-string logic.
  const stub = (scope: string) => ({
    did: 'did:plc:scope-test',
    handle: 'scope-test.example.com',
    email: 'scope-test@example.test',
    status: 'active',
    scope,
  })

  it('accepts a session-scope account for any required scope', () => {
    const acct = stub('session')
    // Both calls must return undefined (no throw).
    expect(() => requireScope(acct, 'atproto')).not.toThrow()
    expect(() => requireScope(acct, 'transition:generic')).not.toThrow()
  })

  it('accepts a transition:generic token for transition:generic', () => {
    const acct = stub('atproto transition:generic')
    expect(() => requireScope(acct, 'transition:generic')).not.toThrow()
  })

  it('accepts a transition:generic token for atproto (implies it)', () => {
    // Tokens issued with only 'transition:generic' (no explicit 'atproto')
    // still cover the narrower scope — the broader one is a superset.
    const acct = stub('transition:generic')
    expect(() => requireScope(acct, 'atproto')).not.toThrow()
  })

  it('accepts an atproto-only token for atproto', () => {
    const acct = stub('atproto')
    expect(() => requireScope(acct, 'atproto')).not.toThrow()
  })

  it('rejects an atproto-only token for transition:generic', async () => {
    const acct = stub('atproto')
    await expectXrpcError(
      () => Promise.resolve(requireScope(acct, 'transition:generic')),
      403,
      'InsufficientScope',
    )
  })

  it('rejects a token with an unrelated scope string', async () => {
    const acct = stub('com.example.bespoke')
    await expectXrpcError(
      () => Promise.resolve(requireScope(acct, 'atproto')),
      403,
      'InsufficientScope',
    )
  })
})
