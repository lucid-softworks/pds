// Background retention sweep for `repo_seq`.
//
// `PDS_FIREHOSE_RETENTION_DAYS` (config field `firehoseRetentionDays`)
// gates whether this runs at all. When set, we GC rows older than the
// cutoff once per hour. Re-import is a no-op; the started flag dedupes
// repeat calls.
//
// We deliberately don't run on hot-reload (the in-process timer is
// not unique across HMR boots), so this is only wired from the
// production start path. In dev nobody cares.
//
// See chapter 16 — Event sequencer and the firehose.

import { gcRepoSeq } from './sequence'
import { getConfig } from '~/lib/config'
import { getLogger } from '~/lib/logger'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // hourly
const log = getLogger('firehose-retention')

let started = false
let timer: ReturnType<typeof setInterval> | null = null

/** Start the periodic GC sweep. Idempotent across multiple calls. */
export function startRetentionSweeps(): void {
  if (started) return
  const cfg = getConfig()
  if (cfg.firehoseRetentionDays === null) {
    log.debug('PDS_FIREHOSE_RETENTION_DAYS unset; sweep disabled')
    return
  }
  started = true
  // Run once at startup (after a short delay so the boot path isn't
  // bottlenecked on a long DELETE), then on a recurring timer.
  setTimeout(() => void runOnce(cfg.firehoseRetentionDays), 30_000)
  timer = setInterval(
    () => void runOnce(cfg.firehoseRetentionDays),
    SWEEP_INTERVAL_MS,
  )
}

/** Stop the sweep. Called from the shutdown coordinator so a graceful
 *  exit doesn't leave a half-finished DELETE in flight. */
export function stopRetentionSweeps(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  started = false
}

async function runOnce(retentionDays: number | null): Promise<void> {
  try {
    const deleted = await gcRepoSeq(retentionDays)
    if (deleted > 0) {
      log.info('repo_seq GC swept stale rows', {
        deleted,
        retentionDays,
      })
    }
  } catch (err) {
    log.error('repo_seq GC failed', { err })
  }
}
