// XRPC handler: tools.ozone.communication.createTemplate
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/communication/createTemplate.json

import { z } from 'zod'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict } from '../errors'
import { db } from '~/lib/db'
import { ozoneCommTemplates } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const InputSchema = z.object({
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(280),
  contentMarkdown: z.string().min(1),
  lang: z.string().max(8).optional(),
  createdBy: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const lastUpdatedBy = auth.kind === 'admin' ? null : auth.did
  try {
    const inserted = await pg
      .insert(ozoneCommTemplates)
      .values({
        name: parsed.data.name,
        subject: parsed.data.subject,
        contentMarkdown: parsed.data.contentMarkdown,
        lang: parsed.data.lang ?? null,
        lastUpdatedBy,
      })
      .returning({
        id: ozoneCommTemplates.id,
        createdAt: ozoneCommTemplates.createdAt,
        updatedAt: ozoneCommTemplates.updatedAt,
      })
    const row = inserted[0]!
    return view(row.id, parsed.data, row.createdAt, row.updatedAt, lastUpdatedBy)
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '23505') {
      throw Conflict(
        `template name already exists: ${parsed.data.name}`,
        'DuplicateTemplateName',
      )
    }
    throw err
  }
}

function view(
  id: number,
  v: z.infer<typeof InputSchema>,
  createdAt: Date,
  updatedAt: Date,
  lastUpdatedBy: string | null,
) {
  return {
    id: String(id),
    name: v.name,
    subject: v.subject,
    contentMarkdown: v.contentMarkdown,
    ...(v.lang !== undefined ? { lang: v.lang } : {}),
    disabled: false,
    lastUpdatedBy: lastUpdatedBy ?? 'admin',
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.communication.createTemplate'
