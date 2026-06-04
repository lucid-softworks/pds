// XRPC handler: tools.ozone.moderation.getEvent
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/getEvent.json
//
// Single moderation event by id. The event view is reconstructed from
// the persisted DAG-CBOR snapshot so the response matches exactly
// what the caller submitted to `emitEvent`, plus the assigned id /
// createdAt.
//
// See chapter 24 — Ozone-shaped moderation.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { modEvents } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { decode } from '~/pds/codec'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  if (params.id === undefined) {
    throw BadRequest('id parameter is required', 'InvalidRequest')
  }
  const id = Number.parseInt(params.id, 10)
  if (!Number.isFinite(id) || id < 1) {
    throw BadRequest('id must be a positive integer', 'InvalidRequest')
  }

  const rows = await db
    .select()
    .from(modEvents)
    .where(eq(modEvents.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`event not found: ${id}`, 'EventNotFound')

  const snapshot = await decode<Record<string, unknown>>(row.metadata)
  return {
    id: row.id,
    event: snapshot.event,
    subject: snapshot.subject,
    subjectBlobCids: snapshot.subjectBlobCids ?? [],
    createdBy: row.createdByDid,
    createdAt: row.createdAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.getEvent'
