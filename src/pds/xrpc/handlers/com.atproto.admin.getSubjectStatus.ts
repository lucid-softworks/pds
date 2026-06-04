// XRPC handler: com.atproto.admin.getSubjectStatus
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/getSubjectStatus.json
//
// Read side of subject-level moderation. Same subject-type dispatch as
// `updateSubjectStatus`, three query shapes:
//
//   ?did=did:plc:...                       → account-level
//   ?did=did:plc:...&blob=bafy...          → blob-level
//   ?uri=at://did:plc:.../<col>/<rkey>     → record-level
//
// Output shape matches the lexicon:
//
//   {
//     subject: <repoRef | strongRef | repoBlobRef>,
//     takedown?: { applied: true, ref: <stored ref> },
//     deactivated?: { applied: true }   // for accounts only
//   }
//
// Fields are omitted (not nulled) when the corresponding moderation
// state isn't in force — that's what the reference does.

import { and, eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts, blobs, records } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'

const handler: Handler = async ({ params, authorization }) => {
  await requireAdmin(authorization)

  const did = params.did?.trim()
  const uri = params.uri?.trim()
  const blob = params.blob?.trim()

  if (blob) {
    if (!did) {
      throw BadRequest(
        'Must provide a did to request blob state',
        'InvalidRequest',
      )
    }
    const rows = await db
      .select({ takedownRef: blobs.takedownRef })
      .from(blobs)
      .where(and(eq(blobs.creator, did), eq(blobs.cid, blob)))
      .limit(1)
    const row = rows[0]
    if (!row) throw NotFound(`blob not found: ${blob}`, 'BlobNotFound')
    return {
      subject: {
        $type: 'com.atproto.admin.defs#repoBlobRef',
        did,
        cid: blob,
      },
      ...(row.takedownRef
        ? { takedown: { applied: true, ref: row.takedownRef } }
        : {}),
    }
  }

  if (uri) {
    const parsed = parseAtUri(uri)
    const rows = await db
      .select({
        cid: records.cid,
        takedownRef: records.takedownRef,
      })
      .from(records)
      .where(
        and(
          eq(records.repoDid, parsed.repoDid),
          eq(records.collection, parsed.collection),
          eq(records.rkey, parsed.rkey),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) throw NotFound(`record not found: ${uri}`, 'RecordNotFound')
    return {
      subject: {
        $type: 'com.atproto.repo.strongRef',
        uri,
        cid: row.cid,
      },
      ...(row.takedownRef
        ? { takedown: { applied: true, ref: row.takedownRef } }
        : {}),
    }
  }

  if (did) {
    const rows = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.did, did))
      .limit(1)
    const row = rows[0]
    if (!row) throw NotFound(`account not found: ${did}`, 'AccountNotFound')
    return {
      subject: { $type: 'com.atproto.admin.defs#repoRef', did },
      ...(row.status === 'takendown'
        ? { takedown: { applied: true, ref: '1' } }
        : {}),
      ...(row.status === 'deactivated'
        ? { deactivated: { applied: true } }
        : {}),
    }
  }

  throw BadRequest(
    'must provide at least one of did, uri, or blob',
    'InvalidRequest',
  )
}

function parseAtUri(uri: string): {
  repoDid: string
  collection: string
  rkey: string
} {
  if (!uri.startsWith('at://')) {
    throw BadRequest(`invalid AT-URI: ${uri}`, 'InvalidRequest')
  }
  const rest = uri.slice('at://'.length)
  const [did, collection, rkey] = rest.split('/')
  if (!did || !collection || !rkey) {
    throw BadRequest(`invalid AT-URI: ${uri}`, 'InvalidRequest')
  }
  return { repoDid: did, collection, rkey }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.admin.getSubjectStatus'
