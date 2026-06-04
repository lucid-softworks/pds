// Background sweep that fires due scheduled-actions rows.
//
// Every 30 seconds we look for `mod_scheduled_actions` rows whose
// `fires_at` has passed and whose `state` is still `pending`. For each:
//
//   - decode the stored `action` payload back into an emitEvent shape
//   - call applyEmitEvent() — same code path the XRPC handler uses
//   - on success, flip state → 'completed' and record fired_at
//   - on failure, flip state → 'failed' and record the error message
//
// Idempotent across re-imports (we set a module-level `started` flag).
// In dev, importing this module wouldn't actually start the sweep —
// we only call startScheduledActionSweeps() from the production
// server.ts entry point.
//
// See chapter 24 — Ozone-shaped moderation (Scheduled actions).

import { and, eq, lt } from 'drizzle-orm'
import { db } from '~/lib/db'
import { modScheduledActions } from '~/lib/db/schema'
import { decode } from '~/pds/codec'
import { getLogger } from '~/lib/logger'
import { applyEmitEvent } from './events'
import { getModTeamLead } from './team'

const SWEEP_INTERVAL_MS = 30 * 1000
const log = getLogger('mod-scheduler')

let started = false
let timer: ReturnType<typeof setInterval> | null = null

export function startScheduledActionSweeps(): void {
  if (started) return
  started = true
  // Run after a short boot delay to let the rest of the process settle.
  setTimeout(() => void runOnce(), 5_000)
  timer = setInterval(() => void runOnce(), SWEEP_INTERVAL_MS)
}

export function stopScheduledActionSweeps(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  started = false
}

async function runOnce(): Promise<void> {
  let due
  try {
    due = await db
      .select()
      .from(modScheduledActions)
      .where(
        and(
          eq(modScheduledActions.state, 'pending'),
          lt(modScheduledActions.firesAt, new Date()),
        ),
      )
      .limit(50)
  } catch (err) {
    log.error('scheduled-action lookup failed', { err })
    return
  }
  if (due.length === 0) return

  const lead = await getModTeamLead()
  for (const row of due) {
    try {
      const payload = await decode<{
        action: { $type: string; comment?: string; durationInHours?: number }
        createdBy: string
      }>(row.payload)
      // Synthesise an emitEvent input from the scheduled payload. The
      // only currently-supported action shape is the takedown variant;
      // we translate it into modEventTakedown and let applyEmitEvent
      // run the existing side effects.
      const eventType = 'tools.ozone.moderation.defs#modEventTakedown'
      const event = {
        $type: eventType,
        ...(payload.action.comment !== undefined
          ? { comment: payload.action.comment }
          : {}),
        ...(payload.action.durationInHours !== undefined
          ? { durationInHours: payload.action.durationInHours }
          : {}),
      }
      await applyEmitEvent({
        input: {
          event,
          subject: {
            $type: 'com.atproto.admin.defs#repoRef',
            did: row.subjectDid,
          },
          createdBy: payload.createdBy,
        },
        labelSrcDid: lead?.did ?? null,
      })
      await db
        .update(modScheduledActions)
        .set({ state: 'completed', firedAt: new Date() })
        .where(eq(modScheduledActions.id, row.id))
      log.info('scheduled action fired', {
        id: row.id,
        actionType: row.actionType,
        subject: row.subjectDid,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await db
        .update(modScheduledActions)
        .set({ state: 'failed', firedAt: new Date(), failedReason: reason })
        .where(eq(modScheduledActions.id, row.id))
      log.warn('scheduled action failed', {
        id: row.id,
        subject: row.subjectDid,
        reason,
      })
    }
  }
}
