// XRPC handler: tools.ozone.communication.listTemplates
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/communication/listTemplates.json

import { asc } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { db } from '~/lib/db'
import { ozoneCommTemplates } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ authorization }) => {
  await requireModerator(authorization)
  const rows = await db
    .select()
    .from(ozoneCommTemplates)
    .orderBy(asc(ozoneCommTemplates.name))
  return {
    communicationTemplates: rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      subject: r.subject,
      contentMarkdown: r.contentMarkdown,
      ...(r.lang !== null ? { lang: r.lang } : {}),
      disabled: r.disabled,
      lastUpdatedBy: r.lastUpdatedBy ?? 'admin',
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.communication.listTemplates'
