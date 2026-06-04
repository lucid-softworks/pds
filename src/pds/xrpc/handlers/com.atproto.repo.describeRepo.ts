// XRPC handler: com.atproto.repo.describeRepo
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/describeRepo.json
//
// Returns identity + structural metadata about a repo. No auth — repos are
// public. The collections list comes from `records` (which is the source of
// truth for "what NSIDs has this user written?").

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts, records } from '~/lib/db/schema'
import { buildDidDocument } from '~/pds/did/document'
import { isLabelerDid } from '~/pds/mod/team'
import { getConfig } from '~/lib/config'
import { resolveRepoIdent } from './_lib/resolveRepo'

const handler: Handler = async ({ params }) => {
  const repo = params.repo
  if (!repo) throw BadRequest('repo is required', 'InvalidRequest')
  const did = await resolveRepoIdent(repo)

  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      signingKeyPub: accounts.signingKeyPub,
    })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const acct = rows[0]
  if (!acct) throw NotFound(`unknown repo: ${repo}`, 'RepoNotFound')

  // SELECT DISTINCT collection FROM records WHERE repo_did = ?
  const distinct = await db
    .selectDistinct({ collection: records.collection })
    .from(records)
    .where(eq(records.repoDid, did))

  const didDoc = buildDidDocument({
    did: acct.did,
    handle: acct.handle,
    signingKeyMultibase: acct.signingKeyPub,
    pdsEndpoint: getConfig().publicUrl,
    isLabeler: await isLabelerDid(acct.did),
  })

  // handleIsCorrect tells the client whether the DID's resolved handle agrees
  // with the handle in the DID document. For our local accounts these are
  // the same record, so it's always true.
  return {
    handle: acct.handle,
    did: acct.did,
    didDoc,
    collections: distinct.map((r) => r.collection).sort(),
    handleIsCorrect: true,
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.repo.describeRepo'
