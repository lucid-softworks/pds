// Structured JSON logger.
//
// One line of JSON per log message, written to stdout for trace/debug/info and
// stderr for warn/error/fatal so a log shipper that splits streams (k8s log
// driver, journald, systemd) can pre-filter without re-parsing. Levels are
// hierarchical: at `level=info`, debug+trace drop on the floor; at `level=warn`,
// info also drops; etc. The minimum level is read from `PDS_LOG_LEVEL` via
// `getConfig().logLevel` on first emit and cached for the process lifetime.
//
// `getLogger(component).with({ k: v })` returns a child logger whose fields
// are merged into every line — that's how the dispatcher attaches `nsid` +
// `method` without each call-site repeating itself.
//
// Errors get a small special case: if any field's value is an `Error`, we
// move it onto a top-level `err` key with `{ message, name, stack }` so log
// aggregators that index `err.stack` can find them.
//
// Pretty mode (env `PDS_LOG_PRETTY=true`, default-on when NODE_ENV !==
// 'production') swaps the JSON for a coloured human-readable line. Defaults
// make `pnpm dev` readable and `pnpm start` JSON-shipped.
//
// No new dependency: stdout/stderr writes are the runtime primitives.
//
// See chapter 18 — Production observability.

import { getConfig } from './config'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type LogFields = Record<string, unknown>

export type Logger = {
  trace(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  fatal(msg: string, fields?: LogFields): void
  /** Returns a child logger with the given fields merged into every line. */
  with(fields: LogFields): Logger
}

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const PRETTY_COLOURS: Record<LogLevel, string> = {
  trace: '\x1b[90m', // grey
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
}
const RESET = '\x1b[0m'

let cachedMinLevel: number | null = null
let cachedPretty: boolean | null = null

function minLevel(): number {
  if (cachedMinLevel !== null) return cachedMinLevel
  // Read PDS_LOG_LEVEL directly first to avoid forcing the full config
  // (which requires PDS_JWT_SECRET) when callers just want to log.
  const raw = (process.env.PDS_LOG_LEVEL ?? '').toLowerCase()
  if (raw && raw in LEVELS) {
    cachedMinLevel = LEVELS[raw as LogLevel]
    return cachedMinLevel
  }
  // Fall back to config — but tolerate a config that hasn't been wired yet.
  try {
    const cfg = getConfig()
    cachedMinLevel = LEVELS[cfg.logLevel]
  } catch {
    cachedMinLevel = LEVELS.info
  }
  return cachedMinLevel
}

function prettyMode(): boolean {
  if (cachedPretty !== null) return cachedPretty
  const raw = process.env.PDS_LOG_PRETTY
  if (raw === 'true') {
    cachedPretty = true
  } else if (raw === 'false') {
    cachedPretty = false
  } else {
    cachedPretty = process.env.NODE_ENV !== 'production'
  }
  return cachedPretty
}

/** Reset cached level + pretty flag. Tests call this between cases when they
 *  twiddle env vars. */
export function resetLoggerCacheForTests(): void {
  cachedMinLevel = null
  cachedPretty = null
}

function emit(
  level: LogLevel,
  component: string | undefined,
  baseFields: LogFields,
  msg: string,
  callFields: LogFields | undefined,
): void {
  if (LEVELS[level] < minLevel()) return
  const merged: LogFields = { ...baseFields, ...(callFields ?? {}) }

  // Hoist any Error value onto `err`. The first one wins; subsequent Errors
  // are stringified.
  let err: { name: string; message: string; stack?: string } | undefined
  for (const key of Object.keys(merged)) {
    const v = merged[key]
    if (v instanceof Error) {
      if (!err) {
        err = { name: v.name, message: v.message, stack: v.stack }
        delete merged[key]
      } else {
        merged[key] = `${v.name}: ${v.message}`
      }
    }
  }

  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    ...(component !== undefined ? { component } : {}),
    msg,
    ...merged,
  }
  if (err) record.err = err

  const line = prettyMode() ? formatPretty(record) : safeJsonStringify(record)
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout
  stream.write(line + '\n')
}

function formatPretty(record: Record<string, unknown>): string {
  const level = record.level as LogLevel
  const colour = PRETTY_COLOURS[level] ?? ''
  const time = String(record.time ?? '')
  const component = record.component ? `[${record.component}] ` : ''
  const msg = String(record.msg ?? '')
  const extras: string[] = []
  for (const key of Object.keys(record)) {
    if (key === 'time' || key === 'level' || key === 'component' || key === 'msg') continue
    extras.push(`${key}=${formatExtra(record[key])}`)
  }
  const tail = extras.length > 0 ? ' ' + extras.join(' ') : ''
  return `${time} ${colour}${level.toUpperCase().padEnd(5)}${RESET} ${component}${msg}${tail}`
}

function formatExtra(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string') {
    return /\s/.test(v) ? JSON.stringify(v) : v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function safeJsonStringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record)
  } catch {
    // Circular structure — fall back to a minimal record so we never throw
    // from a log call.
    return JSON.stringify({
      time: record.time,
      level: record.level,
      msg: record.msg,
      _stringifyError: true,
    })
  }
}

function makeLogger(
  component: string | undefined,
  baseFields: LogFields,
): Logger {
  return {
    trace: (msg, fields) => emit('trace', component, baseFields, msg, fields),
    debug: (msg, fields) => emit('debug', component, baseFields, msg, fields),
    info: (msg, fields) => emit('info', component, baseFields, msg, fields),
    warn: (msg, fields) => emit('warn', component, baseFields, msg, fields),
    error: (msg, fields) => emit('error', component, baseFields, msg, fields),
    fatal: (msg, fields) => emit('fatal', component, baseFields, msg, fields),
    with: (fields) => makeLogger(component, { ...baseFields, ...fields }),
  }
}

/** Build a logger tagged with `component`. Pass it to subsystems so every
 *  emitted line is greppable by component name. */
export function getLogger(component?: string): Logger {
  return makeLogger(component, {})
}
