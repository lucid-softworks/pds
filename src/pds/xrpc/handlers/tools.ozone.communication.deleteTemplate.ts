// XRPC handler: tools.ozone.communication.deleteTemplate
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/communication/deleteTemplate.json

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { ozoneCommTemplates } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({ id: z.string().min(1) })

const handler: Handler = async ({ input, authorization }) => {
  await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const id = Number.parseInt(parsed.data.id, 10)
  if (!Number.isFinite(id)) throw BadRequest('invalid id', 'InvalidRequest')
  const existing = (
    await db
      .select({ id: ozoneCommTemplates.id })
      .from(ozoneCommTemplates)
      .where(eq(ozoneCommTemplates.id, id))
      .limit(1)
  )[0]
  if (!existing) throw NotFound(`template not found: ${id}`, 'TemplateNotFound')
  await db.delete(ozoneCommTemplates).where(eq(ozoneCommTemplates.id, id))
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.communication.deleteTemplate'
