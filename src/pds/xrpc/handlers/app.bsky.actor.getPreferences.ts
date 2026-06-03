// XRPC handler: app.bsky.actor.getPreferences
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/actor/getPreferences.json
//
// Returns the calling user's stored bsky.app preferences. Preferences are
// a JSON array of tagged-union objects (adultContentPref, mutedWordsPref,
// feedViewPref, …) — the PDS stores them verbatim; the AppView + client
// own the schema.
//
// In the namespace `app.bsky.*`, *this* method (and putPreferences) is
// one of the few that's PDS-served rather than AppView-served — bsky.app
// expects the user's PDS to be the source of truth for their preferences,
// then reads them back to personalise AppView responses.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { InternalError } from '../errors'
import { requireEitherAuth } from '~/pds/auth/middleware'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'

const handler: Handler = async ({ request, authorization, dpopProof }) => {
  const me = await requireEitherAuth({
    authorization,
    dpopProof,
    request,
  })

  const row = (
    await db
      .select({ preferences: accounts.preferences })
      .from(accounts)
      .where(eq(accounts.did, me.did))
      .limit(1)
  )[0]

  // The account row exists — requireEitherAuth loaded it for us — so the
  // only way this falls through is a transient race. Treat as a 500.
  if (!row) throw InternalError('account row missing after auth')

  let preferences: unknown
  try {
    preferences = JSON.parse(row.preferences)
  } catch {
    // We wrote this. If it doesn't parse, the row is corrupt — surface
    // it loudly rather than silently returning `[]`.
    throw InternalError('stored preferences are not valid JSON')
  }
  if (!Array.isArray(preferences)) {
    throw InternalError('stored preferences are not a JSON array')
  }
  return { preferences }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'app.bsky.actor.getPreferences'
