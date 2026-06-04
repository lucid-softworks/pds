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
import { accounts, modTeam, records, type ModTeamMember } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import { getKeyWrapper } from '~/pds/auth/key_wrap'
import { ensureLabelerService } from '~/pds/did/plc'
import { emitIdentity } from '~/pds/sequencer/sequence'
import { applyWrites } from '~/pds/repo/writes'

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
  // Best-effort: rotate the lead's PLC op to add the #atproto_labeler
  // service entry if it isn't there yet. Idempotent — returns early
  // when the entry already exists. Failures here don't block the
  // mod-surface read (the labeler is discoverable via our local DID
  // doc until plc.directory catches up).
  await ensureLeadLabelerService(cachedLead.did).catch((err) => {
    console.warn(
      '[mod] failed to ensure labeler service for lead',
      cachedLead?.did,
      err,
    )
  })
  await ensureLeadLabelerRecord(cachedLead.did).catch((err) => {
    console.warn(
      '[mod] failed to ensure app.bsky.labeler.service record for lead',
      cachedLead?.did,
      err,
    )
  })
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

/** True when this DID is the labeler (team-lead). Used by DID-document
 *  builders to add the `#atproto_labeler` service entry on the right
 *  account and skip it everywhere else. Cheap: piggybacks on the
 *  cached team-lead lookup. */
export async function isLabelerDid(did: string): Promise<boolean> {
  const lead = await getModTeamLead()
  return lead?.did === did
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

/** Create the minimal `app.bsky.labeler.service` self-record in the
 *  lead's repo if one doesn't exist yet. The DID-doc service entry
 *  (added by `ensureLeadLabelerService`) is necessary but not
 *  sufficient for bsky.app to surface the account *as* a labeler —
 *  it also indexes this record to learn the labeler's name + label
 *  values.
 *
 *  We ship the smallest valid declaration (empty `labelValues`); a
 *  human operator can later edit the record via `putRecord` to add
 *  the labels they're actually offering. Idempotent — we no-op if
 *  the (collection, rkey) pair is already present. */
async function ensureLeadLabelerRecord(did: string): Promise<void> {
  const existing = await db
    .select({ cid: records.cid })
    .from(records)
    .where(
      and(
        eq(records.repoDid, did),
        eq(records.collection, 'app.bsky.labeler.service'),
        eq(records.rkey, 'self'),
      ),
    )
    .limit(1)
  if (existing.length > 0) return
  await applyWrites({
    did,
    writes: [
      {
        action: 'create',
        collection: 'app.bsky.labeler.service',
        rkey: 'self',
        value: {
          $type: 'app.bsky.labeler.service',
          policies: {
            labelValues: [],
          },
          createdAt: new Date().toISOString(),
        },
      },
    ],
  })
}

/** Unwrap the account's rotation key and rotate its PLC op to include
 *  `#atproto_labeler` if not already advertised. Emits #identity on
 *  success so the network re-resolves the DID document. Called from
 *  `getModTeamLead()` and tolerant of being called when the rotation
 *  isn't needed (early-returns inside `ensureLabelerService`). */
async function ensureLeadLabelerService(did: string): Promise<void> {
  const rows = await db
    .select({ rotationKeyPriv: accounts.rotationKeyPriv, handle: accounts.handle })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const acct = rows[0]
  if (!acct) return
  const rotationKeyPrivPlain = await getKeyWrapper().unwrap(
    acct.rotationKeyPriv,
  )
  const result = await ensureLabelerService({
    did,
    rotationKeyPriv: rotationKeyPrivPlain,
    pdsEndpoint: getConfig().publicUrl,
  })
  if (result !== null) {
    // Op was rotated — nudge AppViews to re-resolve the DID document
    // so the labeler entry becomes visible to bsky.app et al.
    await emitIdentity({ did, handle: acct.handle }).catch(() => {})
  }
}
