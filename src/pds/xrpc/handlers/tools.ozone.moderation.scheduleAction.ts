// XRPC handler: tools.ozone.moderation.scheduleAction
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/scheduleAction.json
//
// Stores a future emitEvent in mod_scheduled_actions for the background
// sweeper to fire. The lexicon allows several scheduling shapes
// (executeAt | executeAfter | duration); we honour executeAt for v1
// and translate the others into an absolute timestamp at write time.

import { z } from 'zod'
import type {
  PgDatabase,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modScheduledActions } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { encode } from '~/pds/codec'

const pg = db as unknown as PgDatabase<PgQueryResultHKT>

const TakedownAction = z.object({
  $type: z.literal('tools.ozone.moderation.scheduleAction#takedown'),
  comment: z.string().optional(),
  durationInHours: z.number().int().positive().optional(),
  acknowledgeAccountSubjects: z.boolean().optional(),
  policies: z.array(z.string()).max(5).optional(),
})

const SchedulingConfig = z
  .object({
    executeAt: z.string().optional(),
    executeAfter: z.string().optional(),
    executeUntil: z.string().optional(),
  })
  .refine(
    (c) => c.executeAt !== undefined || c.executeAfter !== undefined,
    'scheduling must specify executeAt or executeAfter',
  )

const InputSchema = z.object({
  action: TakedownAction,
  subjects: z.array(z.string().regex(/^did:/)).min(1).max(100),
  createdBy: z.string().regex(/^did:/),
  scheduling: SchedulingConfig,
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  // Moderator-DID auth must match createdBy (mirrors emitEvent).
  if (auth.kind === 'moderator' && parsed.data.createdBy !== auth.did) {
    throw BadRequest(
      `createdBy must equal the authenticated moderator DID (${auth.did})`,
      'InvalidRequest',
    )
  }

  const firesAt = resolveExecuteAt(parsed.data.scheduling)
  if (firesAt.getTime() <= Date.now()) {
    throw BadRequest(
      'scheduled time must be in the future',
      'InvalidRequest',
    )
  }

  // Insert one row per subject. The sweeper fires them independently —
  // a single batch can partially succeed without rolling back already-
  // fired siblings.
  const rows: Array<{ id: number; subjectDid: string; firesAt: Date }> = []
  for (const subject of parsed.data.subjects) {
    const payload = (await encode({
      action: parsed.data.action,
      createdBy: parsed.data.createdBy,
    })).bytes
    const inserted = await pg
      .insert(modScheduledActions)
      .values({
        actionType: 'takedown',
        subjectDid: subject,
        firesAt,
        payload,
        createdBy: parsed.data.createdBy,
      })
      .returning({
        id: modScheduledActions.id,
        subjectDid: modScheduledActions.subjectDid,
        firesAt: modScheduledActions.firesAt,
      })
    rows.push(inserted[0]!)
  }

  return {
    results: rows.map((r) => ({
      id: String(r.id),
      subject: r.subjectDid,
      firesAt: r.firesAt.toISOString(),
    })),
  }
}

function resolveExecuteAt(scheduling: {
  executeAt?: string
  executeAfter?: string
}): Date {
  if (scheduling.executeAt) {
    const d = new Date(scheduling.executeAt)
    if (Number.isNaN(d.getTime())) {
      throw BadRequest('invalid executeAt timestamp', 'InvalidRequest')
    }
    return d
  }
  // executeAfter is an ISO-8601 duration (e.g. P1D). Browsers don't ship
  // a parser, so we accept a minimal subset: "PT<n>H", "P<n>D".
  if (scheduling.executeAfter) {
    const m = /^P(?:T(\d+)H|(\d+)D)$/.exec(scheduling.executeAfter)
    if (!m) {
      throw BadRequest(
        'executeAfter must match PT<hours>H or P<days>D',
        'InvalidRequest',
      )
    }
    const hours = m[1] ? Number(m[1]) : Number(m[2]) * 24
    return new Date(Date.now() + hours * 3_600_000)
  }
  throw BadRequest(
    'scheduling.executeAt or executeAfter required',
    'InvalidRequest',
  )
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.moderation.scheduleAction'
