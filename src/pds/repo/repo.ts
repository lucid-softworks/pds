// High-level repo orchestration.
//
// Right now this file exposes one operation: create the genesis state of a
// new repository. Subsequent chapters add applyWrites/getRecord/etc.

import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { repos } from '~/lib/db/schema'
import { parseCid, type CID } from '~/pds/codec'
import { emptyMst } from './mst'
import { buildSignedCommit } from './commit'
import { nextTid } from './tid'
import { putBlocks } from './blockstore'

export type GenesisResult = {
  rootCid: CID
  rev: string
}

/** Build, sign, and persist the genesis state of a new repo. Idempotent:
 *  if a repo already exists for this DID, returns its current state. */
export async function createGenesisRepo(args: {
  did: string
  signingKeyPriv: string
}): Promise<GenesisResult> {
  const existing = await db
    .select()
    .from(repos)
    .where(eq(repos.did, args.did))
    .limit(1)
  if (existing[0]) {
    return {
      rootCid: parseCid(existing[0].rootCid),
      rev: existing[0].rev,
    }
  }

  const mstBlock = await emptyMst()
  const rev = nextTid()
  const commitBlock = await buildSignedCommit({
    did: args.did,
    data: mstBlock.cid,
    rev,
    signingKeyPriv: args.signingKeyPriv,
  })

  await putBlocks(args.did, [mstBlock, commitBlock])
  await db.insert(repos).values({
    did: args.did,
    rootCid: commitBlock.cid.toString(),
    rev,
  })

  return { rootCid: commitBlock.cid, rev }
}
