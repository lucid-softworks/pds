// XRPC handler: app.bsky.actor.putPreferences
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/actor/putPreferences.json
//
// Replaces the calling user's stored preferences wholesale. The body must
// be `{ preferences: [...] }` — an array of tagged objects with `$type`
// fields from the `app.bsky.actor.defs` namespace.
//
// We do shape-validation but not type-validation: anything that's a JSON
// array of `{ $type: 'app.bsky.actor.defs#…', … }` objects is accepted.
// The AppView + client own the union types; cross-validating here would
// just couple this PDS to a moving target.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireEitherAuth } from '~/pds/auth/middleware'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'

const MAX_PREFERENCES_BYTES = 64 * 1024 // 64 KiB is plenty; bsky's own
// reference PDS caps similarly. Stops a runaway client from filling the
// row with garbage and the JSONB store from growing pathologically.

const handler: Handler = async ({ request, input, authorization, dpopProof }) => {
  const me = await requireEitherAuth({
    authorization,
    dpopProof,
    request,
  })

  if (!input || typeof input !== 'object' || !('preferences' in input)) {
    throw BadRequest('input must be { preferences: [...] }', 'InvalidRequest')
  }
  const preferences = (input as { preferences: unknown }).preferences
  if (!Array.isArray(preferences)) {
    throw BadRequest('preferences must be an array', 'InvalidRequest')
  }
  for (let i = 0; i < preferences.length; i++) {
    const p = preferences[i]
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw BadRequest(
        `preferences[${i}] must be an object`,
        'InvalidRequest',
      )
    }
    const t = (p as Record<string, unknown>).$type
    if (typeof t !== 'string' || !t.startsWith('app.bsky.actor.defs#')) {
      throw BadRequest(
        `preferences[${i}].$type must start with "app.bsky.actor.defs#"`,
        'InvalidRequest',
      )
    }
  }

  const serialized = JSON.stringify(preferences)
  if (serialized.length > MAX_PREFERENCES_BYTES) {
    throw BadRequest(
      `preferences exceed ${MAX_PREFERENCES_BYTES}-byte limit`,
      'InvalidRequest',
    )
  }

  // `requireEitherAuth` already loaded the account row for us, so the
  // UPDATE is guaranteed to hit exactly one row. We don't bother with
  // `.returning(...)` (drizzle's UPDATE-returning typing depends on the
  // driver and would only buy a tautological "did we just update this
  // row" check anyway).
  await db
    .update(accounts)
    .set({ preferences: serialized })
    .where(eq(accounts.did, me.did))
  // Lexicon defines no response body.
  return {}
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'app.bsky.actor.putPreferences'
