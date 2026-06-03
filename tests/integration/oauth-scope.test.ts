// OAuth scope gating at the XRPC dispatcher boundary.
//
// `requireAuthWithScope` enforces the atproto-profile scope rules: a
// minimal `atproto`-only token can identify the caller but can't perform
// writes, while `transition:generic` is the broader scope the user grants
// when they consent to the client writing on their behalf. This test
// drives a real `com.atproto.repo.createRecord` call through the XRPC
// dispatcher with both kinds of token and asserts the dispatcher returns
// 403 InsufficientScope vs 200 accordingly.
//
// We mint the OAuth access tokens directly via `signOauthAccessToken` —
// no PAR / authorize / token dance — because what we're testing is the
// resource-server side, not the issuance side (that's covered by
// `oauth-front-half.test.ts` and `oauth-xrpc-access.test.ts`).

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()
process.env.PDS_OAUTH_SIGNING_KEY ??=
  '4444444444444444444444444444444444444444444444444444444444444444'

import {
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint,
} from 'jose'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createAccount } from '~/pds/account/create'
import { signOauthAccessToken } from '~/pds/oauth/tokens'
import {
  signDpopProof,
  _resetDpopJtiCache,
} from '~/pds/oauth/dpop'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

const PUBLIC_URL = 'http://localhost:3000'

beforeAll(async () => {
  await migrateProcessDb()
})

beforeEach(() => {
  // The DPoP replay cache holds jti values for 60 s; isolating each case
  // means we can reuse the helper-minted proof shape across tests without
  // crossing wires.
  _resetDpopJtiCache()
})

describe('OAuth scope enforcement at the XRPC dispatcher', () => {
  const handle = `oauth-scope-${Date.now()}.example.com`
  const email = `oauth-scope-${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  let did: string

  beforeAll(async () => {
    const acct = await createAccount({ handle, email, password })
    did = acct.did
  })

  /** Mint an OAuth access token + a fresh DPoP keypair, return both plus a
   *  helper to sign proofs against them. */
  async function mintToken(scope: string): Promise<{
    accessJwt: string
    proofFor: (method: string, url: string) => Promise<string>
  }> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    const publicJwk = await exportJWK(publicKey)
    const jkt = await calculateJwkThumbprint(publicJwk, 'sha256')
    const { jwt: accessJwt } = await signOauthAccessToken({
      did,
      scope,
      dpopJkt: jkt,
    })
    return {
      accessJwt,
      proofFor: (method, url) =>
        signDpopProof({
          publicJwk,
          privateKey,
          alg: 'ES256',
          httpMethod: method,
          httpUri: url,
        }),
    }
  }

  async function callCreateRecord(opts: {
    accessJwt: string
    proof: string
  }): Promise<{ status: number; body: unknown }> {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.repo.createRecord`
    const req = new Request(url, {
      method: 'POST',
      headers: {
        authorization: `DPoP ${opts.accessJwt}`,
        dpop: opts.proof,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: 'scope-gating probe',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    })
    const res = await dispatch(registry, 'com.atproto.repo.createRecord', req)
    const text = await res.text()
    let body: unknown = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { status: res.status, body }
  }

  it('rejects an atproto-only OAuth token with 403 InsufficientScope', async () => {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.repo.createRecord`
    const { accessJwt, proofFor } = await mintToken('atproto')
    const proof = await proofFor('POST', url)
    const { status, body } = await callCreateRecord({ accessJwt, proof })
    expect(status).toBe(403)
    expect((body as { error: string }).error).toBe('InsufficientScope')
  })

  it('accepts a transition:generic OAuth token with 200', async () => {
    const url = `${PUBLIC_URL}/xrpc/com.atproto.repo.createRecord`
    const { accessJwt, proofFor } = await mintToken(
      'atproto transition:generic',
    )
    const proof = await proofFor('POST', url)
    const { status, body } = await callCreateRecord({ accessJwt, proof })
    expect(status).toBe(200)
    const out = body as { uri: string; cid: string }
    expect(out.uri).toMatch(
      new RegExp(`^at://${did}/app\\.bsky\\.feed\\.post/`),
    )
    expect(out.cid).toMatch(/^bafyr/)
  })
})
