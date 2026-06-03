// DID resolver.
//
// For our own accounts, build the document from the local `accounts` table.
// For did:web (the service DID this PDS uses for itself), the document is
// served from /.well-known/did.json — that file route is built separately.
// External DID resolution (other PDSes, did:plc on plc.directory) lives in
// `./external_resolver.ts` and is exposed here for backwards-compatible
// imports.

import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import { buildDidDocument, type DidDocument } from './document'

export async function resolveLocalDid(did: string): Promise<DidDocument | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const acct = rows[0]
  if (!acct) return null
  return buildDidDocument({
    did: acct.did,
    handle: acct.handle,
    signingKeyMultibase: acct.signingKeyPub,
    pdsEndpoint: getConfig().publicUrl,
  })
}

export async function resolveLocalHandle(handle: string): Promise<string | null> {
  const rows = await db
    .select({ did: accounts.did })
    .from(accounts)
    .where(eq(accounts.handle, handle))
    .limit(1)
  return rows[0]?.did ?? null
}

// Re-export the unified resolver for callers that want fallback to
// plc.directory / did:web. Most existing call sites only resolve their own
// DIDs and keep using `resolveLocalDid` — flag-day migration not warranted.
export { resolveDid, resetResolverCache } from './external_resolver'
