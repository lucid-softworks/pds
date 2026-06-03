// XRPC handler: com.atproto.server.createAppPassword
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/createAppPassword.json
//
// Mint a new app password for the calling account. The plaintext is generated
// here and returned in the response — this is the one and only time it's
// visible. After this, the row stores a scrypt hash and the original is gone.
//
// See chapter 13 — Authentication.

import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict } from '../errors'
import { db } from '~/lib/db'
import { appPasswords } from '~/lib/db/schema'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { createAppPassword } from '~/pds/auth/app_password'

const NAME_RE = /^[a-zA-Z0-9._-]{4,32}$/

const InputSchema = z.object({
  name: z.string().regex(NAME_RE, 'name must be 4-32 chars [a-zA-Z0-9._-]'),
  privileged: z.boolean().optional(),
})

const handler: Handler = async ({ input, authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }

  const existing = await db
    .select({ name: appPasswords.name })
    .from(appPasswords)
    .where(
      and(
        eq(appPasswords.did, me.did),
        eq(appPasswords.name, parsed.data.name),
      ),
    )
    .limit(1)
  if (existing[0]) {
    throw Conflict(
      `app password named '${parsed.data.name}' already exists`,
      'AppPasswordNameExists',
    )
  }

  const created = await createAppPassword({
    did: me.did,
    name: parsed.data.name,
    privileged: parsed.data.privileged,
  })

  return {
    name: created.name,
    password: created.password,
    privileged: created.privileged,
    createdAt: created.createdAt.toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.createAppPassword'
