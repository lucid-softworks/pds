// Graceful shutdown coordinator.
//
// One signal handler, one ordered queue. Subsystems call `onShutdown(fn)` at
// startup to register a teardown; on SIGTERM / SIGINT we run them all in
// parallel (each with its own `try/catch` so one stuck closer can't block the
// rest) and then exit cleanly.
//
// We attach the signal handlers lazily — the file's first `onShutdown` call
// installs them. That keeps the module side-effect free for the test runner,
// which would otherwise have to fight signal handlers between test files.
//
// In dev mode, Vite's own process owns the signal handling and reloads the
// module graph on every save, so registrations from a server file route
// rebind on each request. The handler here is most useful under `pnpm start`,
// where the Node entry point is long-lived and signals come from the
// container or process supervisor. We document this caveat in chapter 18.
//
// See chapter 18 — Production observability.

import { getLogger } from './logger'

type Handler = {
  name: string
  fn: () => Promise<void> | void
}

const handlers: Handler[] = []
let signalsAttached = false
let shuttingDown = false

/** Register a teardown to run on SIGTERM / SIGINT. The supplied function
 *  should be idempotent — duplicate signals are coalesced, but a process
 *  manager may still call the same handler if `onShutdown` was invoked twice
 *  for the same subsystem. */
export function onShutdown(name: string, fn: Handler['fn']): void {
  handlers.push({ name, fn })
  attachSignalsIfNeeded()
}

/** Test-only: drop every registered handler. Vitest's per-file fork
 *  isolation means we rarely need this in practice. */
export function _resetShutdownForTests(): void {
  handlers.length = 0
  shuttingDown = false
}

/** Test-only: run every registered handler as if a signal had fired,
 *  without actually calling `process.exit`. Returns the list of failures
 *  (name + thrown error) for assertions. */
export async function _runShutdownForTests(): Promise<
  Array<{ name: string; err: unknown }>
> {
  const failures: Array<{ name: string; err: unknown }> = []
  await Promise.all(
    handlers.map(async (h) => {
      try {
        await h.fn()
      } catch (err) {
        failures.push({ name: h.name, err })
      }
    }),
  )
  return failures
}

function attachSignalsIfNeeded(): void {
  if (signalsAttached) return
  // Vitest sets NODE_ENV=test; refuse to install signal handlers there so
  // a test's onShutdown() registration doesn't poison the worker.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return
  signalsAttached = true
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const log = getLogger('shutdown')
  log.info('signal received, draining', { signal, handlers: handlers.length })
  const drainStart = Date.now()
  await Promise.all(
    handlers.map(async (h) => {
      try {
        await h.fn()
        log.debug('handler done', { handler: h.name })
      } catch (err) {
        log.error('handler failed', {
          handler: h.name,
          err: err instanceof Error ? err : new Error(String(err)),
        })
      }
    }),
  )
  log.info('drain complete', { ms: Date.now() - drainStart })
  // Give stdio a tick to flush before exit. `process.exit` truncates pending
  // writes on some platforms.
  setImmediate(() => process.exit(0))
}
