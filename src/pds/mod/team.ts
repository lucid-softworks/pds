// Moderation-team lookups + bootstrap.
//
// The team-lead account is resolved lazily on first read: we look up the
// handle from `PDS_MOD_TEAM_HANDLE` (default `mod.<hostname>`), find the
// account, and ensure a `mod_team` row exists with `role='lead'`. The
// lookup is cached per process — the lead's handle and DID are stable
// once an account is in place, and a handle rotation requires an
// explicit operator action anyway.
//
// If the handle doesn't resolve (no account yet), every read returns
// `null` and the moderation surface degrades gracefully:
//   - `requireModerator` admits admin Basic but rejects DID auth
//   - the /mod UI returns a guided 503
//   - the labeler DID-document entry is not emitted
//
// See chapter 24 — Ozone-shaped moderation.

import { and, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, modTeam, type ModTeamMember } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'

export type ModTeamLead = {
  did: string
  handle: string
}

let cachedLead: ModTeamLead | null | undefined

/** Resolve + cache the team-lead account. Returns `null` if the
 *  configured handle doesn't map to an account yet (operator hasn't
 *  created `mod.<host>` through signup). Re-call after operator action
 *  via `clearModTeamCache()` to force a re-resolve. */
export async function getModTeamLead(): Promise<ModTeamLead | null> {
  if (cachedLead !== undefined) return cachedLead
  const handle = getConfig().modTeamHandle
  const rows = await db
    .select({ did: accounts.did, handle: accounts.handle })
    .from(accounts)
    .where(eq(accounts.handle, handle))
    .limit(1)
  const row = rows[0]
  if (!row) {
    cachedLead = null
    return null
  }
  cachedLead = { did: row.did, handle: row.handle }
  await ensureLeadRow(cachedLead.did)
  return cachedLead
}

/** Re-fetch the team lead on the next call. Useful after admin actions
 *  that create or rename the team-lead account. */
export function clearModTeamCache(): void {
  cachedLead = undefined
}

/** Is this DID authorised to operate the moderation surface? Returns true
 *  for any row in `mod_team` regardless of role. */
export async function isModerator(did: string): Promise<boolean> {
  const rows = await db
    .select({ did: modTeam.did })
    .from(modTeam)
    .where(eq(modTeam.did, did))
    .limit(1)
  return rows.length > 0
}

/** Add a moderator to the team. `addedBy` is the operator who performed
 *  the action (an admin Basic call leaves this null). Idempotent: a
 *  second insert with the same DID is a no-op. */
export async function addModerator(args: {
  did: string
  role: 'lead' | 'moderator'
  addedBy?: string | null
}): Promise<void> {
  await db
    .insert(modTeam)
    .values({
      did: args.did,
      role: args.role,
      addedBy: args.addedBy ?? null,
    })
    .onConflictDoNothing({ target: modTeam.did })
}

/** Remove a moderator. Refuses to remove the team lead — the lead seat
 *  is tied to the team-handle account; rotate it by changing the handle
 *  or the env var. */
export async function removeModerator(did: string): Promise<boolean> {
  const existing = await db
    .select({ role: modTeam.role })
    .from(modTeam)
    .where(eq(modTeam.did, did))
    .limit(1)
  if (existing.length === 0) return false
  if (existing[0]!.role === 'lead') return false
  await db.delete(modTeam).where(eq(modTeam.did, did))
  return true
}

/** List every moderator on the team. */
export async function listModerators(): Promise<ModTeamMember[]> {
  return db.select().from(modTeam)
}

async function ensureLeadRow(did: string): Promise<void> {
  const existing = await db
    .select({ did: modTeam.did, role: modTeam.role })
    .from(modTeam)
    .where(and(eq(modTeam.did, did), eq(modTeam.role, 'lead')))
    .limit(1)
  if (existing.length > 0) return
  await db
    .insert(modTeam)
    .values({ did, role: 'lead', addedBy: null })
    .onConflictDoNothing({ target: modTeam.did })
}
