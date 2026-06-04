// XRPC handler: tools.ozone.setting.removeOptions
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/setting/removeOptions.json

import { z } from 'zod'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { ozoneSettings } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const InputSchema = z.object({
  keys: z.array(z.string().min(1)).min(1),
  scope: z.enum(['instance', 'personal']),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const personalDid =
    parsed.data.scope === 'personal' && auth.kind === 'moderator'
      ? auth.did
      : null
  await db
    .delete(ozoneSettings)
    .where(
      and(
        inArray(ozoneSettings.key, parsed.data.keys),
        eq(ozoneSettings.scope, parsed.data.scope),
        personalDid
          ? eq(ozoneSettings.managedByDid, personalDid)
          : parsed.data.scope === 'instance'
            ? isNull(ozoneSettings.managedByDid)
            : undefined,
      ),
    )
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.setting.removeOptions'
