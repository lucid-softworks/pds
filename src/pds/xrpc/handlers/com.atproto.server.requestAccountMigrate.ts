// XRPC handler: com.atproto.server.requestAccountMigrate
//
// Source-side entry point for cross-PDS migration. The user is leaving us:
// we mark the account `migrating-out`, mint a service-auth token for the
// destination PDS to present when it pulls our copy of the repo + blobs,
// emit a `#account { active: false }` so firehose consumers stop accepting
// writes from this DID, and return both to the caller. They forward the
// token to the new PDS along with the destination's DID/endpoint.
//
// This is *not* what flips the account to a permanent migrated-out state;
// the destination's eventual `activateAccount` is what "completes" the
// migration, and we have no callback for it today. `migration_state`
// stays `'migrating-out'` until an operator runs the (not-yet-built)
// `accountMigrated` admin action.
//
// See chapter 20 — Migration.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { mintServiceAuth } from '~/pds/auth/service_auth'
import { emitAccount } from '~/pds/sequencer/sequence'

const InputSchema = z.object({
  to: z.string().min(1),
})

// One hour: long enough to drive the destination side end-to-end
// (reserveSigningKey → createAccount → importRepo → listMissingBlobs +
// uploadBlob loop → activateAccount), short enough that a leaked token
// has a bounded blast radius. The `unsafeLongLived` option on
// `signServiceToken` is the explicit opt-in.
const MIGRATION_TTL_SECONDS = 60 * 60

const handler: Handler = async ({ input, authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }

  const destinationUrl = parsed.data.to.trim().replace(/\/$/, '')
  let destUrl: URL
  try {
    destUrl = new URL(destinationUrl)
  } catch {
    throw BadRequest(`'to' is not a valid URL: ${destinationUrl}`, 'BadDestination')
  }

  // Insist on HTTPS unless we ourselves are unencrypted (the dev policy
  // copied from createAccount: localhost-over-http is fine in tests).
  const cfg = getConfig()
  const ourHostname = (() => {
    try {
      return new URL(cfg.publicUrl).hostname
    } catch {
      return ''
    }
  })()
  const allowHttp =
    ourHostname === 'localhost' ||
    ourHostname === '127.0.0.1' ||
    ourHostname.endsWith('.localhost')
  if (destUrl.protocol !== 'https:' && !(allowHttp && destUrl.protocol === 'http:')) {
    throw BadRequest(
      `'to' must be an https URL (got ${destUrl.protocol})`,
      'BadDestination',
    )
  }

  // Resolve the destination's service DID + endpoint by fetching its
  // /.well-known/did.json. We don't trust the URL the user typed for
  // anything other than reaching this document; the destination's
  // self-described identity is what we put in the token's `aud`.
  //
  // `URL.toString()` normalises a bare host into `<scheme>://<host>/` — we
  // strip the trailing slash so the well-known path concatenates cleanly.
  const base = destUrl.toString().replace(/\/$/, '')
  const destination = await fetchDestinationServiceInfo(base)

  // Flip the migration state. Status stays whatever it was — the user
  // can still log in, fetch their repo, etc. Only the firehose marker is
  // a hard "deactivated" so external indexers stop trusting writes.
  await db
    .update(accounts)
    .set({ migrationState: 'migrating-out' })
    .where(eq(accounts.did, me.did))

  // Mint the service token. `lxm` is intentionally absent: the
  // destination uses this single token for getRepo, getBlob, and
  // listMissingBlobs (potentially more). The 60s default cap is replaced
  // by the long-lived branch — this is the only flow today that asks
  // for it.
  const { jwt } = await mintServiceAuth({
    did: me.did,
    audience: destination.did,
    expiresInSeconds: MIGRATION_TTL_SECONDS,
    unsafeLongLived: true,
  })

  // Tell the firehose this DID is in flight. Best-effort: a sequencer
  // failure shouldn't unwind the migration_state flip, and the consumer
  // recovers on its next reconnect.
  try {
    await emitAccount({ did: me.did, active: false, status: 'deactivated' })
  } catch (err) {
    console.error('[requestAccountMigrate] failed to emit #account', err)
  }

  return {
    token: jwt,
    destination: {
      did: destination.did,
      endpoint: destination.endpoint,
    },
  }
}

/** GET `<base>/.well-known/did.json` and pull out the
 *  `AtprotoPersonalDataServer` service entry. We treat any malformed
 *  document, missing service, or HTTP failure as `BadDestination` — the
 *  caller asked us to migrate to a host that doesn't speak the
 *  protocol. */
async function fetchDestinationServiceInfo(
  base: string,
): Promise<{ did: string; endpoint: string }> {
  const url = `${base}/.well-known/did.json`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { accept: 'application/did+ld+json, application/json' },
    })
  } catch (err) {
    throw BadRequest(
      `could not reach destination did.json: ${(err as Error).message}`,
      'BadDestination',
    )
  }
  if (!res.ok) {
    throw BadRequest(
      `destination did.json returned ${res.status}`,
      'BadDestination',
    )
  }
  let doc: unknown
  try {
    doc = await res.json()
  } catch {
    throw BadRequest('destination did.json is not valid JSON', 'BadDestination')
  }
  const obj = doc as {
    id?: unknown
    service?: Array<{ type?: unknown; serviceEndpoint?: unknown }> | unknown
  } | null
  if (!obj || typeof obj !== 'object') {
    throw BadRequest('destination did.json is not an object', 'BadDestination')
  }
  if (typeof obj.id !== 'string' || !obj.id.startsWith('did:')) {
    throw BadRequest(
      'destination did.json missing or malformed `id`',
      'BadDestination',
    )
  }
  if (!Array.isArray(obj.service)) {
    throw BadRequest(
      'destination did.json missing `service` array',
      'BadDestination',
    )
  }
  const entry = obj.service.find(
    (s) =>
      s !== null &&
      typeof s === 'object' &&
      (s as { type?: unknown }).type === 'AtprotoPersonalDataServer',
  )
  if (!entry) {
    throw BadRequest(
      'destination did.json has no AtprotoPersonalDataServer service entry',
      'BadDestination',
    )
  }
  const endpoint = (entry as { serviceEndpoint?: unknown }).serviceEndpoint
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw BadRequest(
      'destination service entry has no serviceEndpoint',
      'BadDestination',
    )
  }
  return { did: obj.id, endpoint }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.requestAccountMigrate'
