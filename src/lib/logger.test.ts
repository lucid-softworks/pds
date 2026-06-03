// Behaviour contract for the structured logger.
//
// We intercept `process.stdout.write` / `process.stderr.write` to capture the
// emitted bytes, then parse each line as JSON. Pretty mode is force-disabled
// via PDS_LOG_PRETTY=false so the tests are stream-format agnostic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Force JSON output regardless of NODE_ENV.
process.env.PDS_LOG_PRETTY = 'false'

import { getLogger, resetLoggerCacheForTests } from './logger'

type WriteFn = (chunk: string | Uint8Array) => boolean

function captureStreams(): { lines: { stream: 'out' | 'err'; line: string }[]; restore: () => void } {
  const lines: { stream: 'out' | 'err'; line: string }[] = []
  const origOut = process.stdout.write.bind(process.stdout) as unknown as WriteFn
  const origErr = process.stderr.write.bind(process.stderr) as unknown as WriteFn

  ;(process.stdout as unknown as { write: WriteFn }).write = ((chunk) => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const part of s.split('\n')) if (part.length > 0) lines.push({ stream: 'out', line: part })
    return true
  }) satisfies WriteFn

  ;(process.stderr as unknown as { write: WriteFn }).write = ((chunk) => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const part of s.split('\n')) if (part.length > 0) lines.push({ stream: 'err', line: part })
    return true
  }) satisfies WriteFn

  return {
    lines,
    restore: () => {
      ;(process.stdout as unknown as { write: WriteFn }).write = origOut
      ;(process.stderr as unknown as { write: WriteFn }).write = origErr
    },
  }
}

describe('logger', () => {
  let cap: ReturnType<typeof captureStreams>

  beforeEach(() => {
    delete process.env.PDS_LOG_LEVEL
    resetLoggerCacheForTests()
    cap = captureStreams()
  })

  afterEach(() => {
    cap.restore()
    resetLoggerCacheForTests()
  })

  it('emits one JSON line per call with the right shape', () => {
    const log = getLogger('test')
    log.info('hello', { foo: 'bar', n: 7 })
    expect(cap.lines).toHaveLength(1)
    const entry = cap.lines[0]!
    expect(entry.stream).toBe('out')
    const parsed = JSON.parse(entry.line)
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('hello')
    expect(parsed.component).toBe('test')
    expect(parsed.foo).toBe('bar')
    expect(parsed.n).toBe(7)
    expect(typeof parsed.time).toBe('string')
    expect(() => new Date(parsed.time as string).toISOString()).not.toThrow()
  })

  it('at default level=info, debug + trace drop and warn+ go to stderr', () => {
    const log = getLogger()
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    log.fatal('f')
    const levels = cap.lines.map((l) => ({ stream: l.stream, level: JSON.parse(l.line).level }))
    expect(levels).toEqual([
      { stream: 'out', level: 'info' },
      { stream: 'err', level: 'warn' },
      { stream: 'err', level: 'error' },
      { stream: 'err', level: 'fatal' },
    ])
  })

  it('PDS_LOG_LEVEL=debug lets debug through but not trace', () => {
    process.env.PDS_LOG_LEVEL = 'debug'
    resetLoggerCacheForTests()
    const log = getLogger()
    log.trace('t')
    log.debug('d')
    log.info('i')
    expect(cap.lines.map((l) => JSON.parse(l.line).level)).toEqual(['debug', 'info'])
  })

  it('with(fields) returns a child whose lines include the parent fields', () => {
    const root = getLogger('xrpc').with({ nsid: 'foo.bar', method: 'GET' })
    const child = root.with({ requestId: 'abc' })
    child.info('handled', { status: 200 })
    const parsed = JSON.parse(cap.lines[0]!.line)
    expect(parsed.nsid).toBe('foo.bar')
    expect(parsed.method).toBe('GET')
    expect(parsed.requestId).toBe('abc')
    expect(parsed.status).toBe(200)
    expect(parsed.component).toBe('xrpc')
  })

  it('hoists an Error value onto the `err` field with the stack', () => {
    const log = getLogger()
    const boom = new Error('boom')
    log.error('failed', { err: boom, op: 'sync' })
    const parsed = JSON.parse(cap.lines[0]!.line)
    expect(parsed.err).toBeDefined()
    expect(parsed.err.message).toBe('boom')
    expect(typeof parsed.err.stack).toBe('string')
    expect(parsed.err.stack).toContain('Error: boom')
    expect(parsed.op).toBe('sync')
    // The raw `err: <Error>` was hoisted, not left in place.
    expect(parsed.err.name).toBe('Error')
  })

  it('does not throw on circular references in fields', () => {
    const log = getLogger()
    const a: { self?: unknown } = {}
    a.self = a
    expect(() => log.info('cyclic', { a })).not.toThrow()
    // We get either a fallback record or a valid JSON line — assert it's
    // parseable and carries our level.
    const parsed = JSON.parse(cap.lines[0]!.line)
    expect(parsed.level).toBe('info')
  })
})
