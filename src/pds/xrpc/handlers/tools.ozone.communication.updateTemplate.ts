// XRPC handler: tools.ozone.communication.updateTemplate
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/communication/updateTemplate.json

import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { ozoneCommTemplates } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  subject: z.string().min(1).max(280).optional(),
  contentMarkdown: z.string().min(1).optional(),
  lang: z.string().max(8).optional(),
  disabled: z.boolean().optional(),
  updatedBy: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
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
      .select()
      .from(ozoneCommTemplates)
      .where(eq(ozoneCommTemplates.id, id))
      .limit(1)
  )[0]
  if (!existing) throw NotFound(`template not found: ${id}`, 'TemplateNotFound')

  const patch: Record<string, unknown> = {
    updatedAt: sql`now()`,
    lastUpdatedBy: auth.kind === 'admin' ? null : auth.did,
  }
  if (parsed.data.name !== undefined) patch.name = parsed.data.name
  if (parsed.data.subject !== undefined) patch.subject = parsed.data.subject
  if (parsed.data.contentMarkdown !== undefined)
    patch.contentMarkdown = parsed.data.contentMarkdown
  if (parsed.data.lang !== undefined) patch.lang = parsed.data.lang
  if (parsed.data.disabled !== undefined)
    patch.disabled = parsed.data.disabled

  await db
    .update(ozoneCommTemplates)
    .set(patch)
    .where(eq(ozoneCommTemplates.id, id))

  const updated = (
    await db
      .select()
      .from(ozoneCommTemplates)
      .where(eq(ozoneCommTemplates.id, id))
      .limit(1)
  )[0]!

  return {
    id: String(updated.id),
    name: updated.name,
    subject: updated.subject,
    contentMarkdown: updated.contentMarkdown,
    ...(updated.lang !== null ? { lang: updated.lang } : {}),
    disabled: updated.disabled,
    lastUpdatedBy: updated.lastUpdatedBy ?? 'admin',
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.communication.updateTemplate'
