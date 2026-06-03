// Behavior contract for the lexicon-validation bridge.
//
// The bridge wraps the lexicon validator with two policies the dispatcher
// relies on:
//
//   - Unknown NSIDs are a no-op (no schema available → don't pretend).
//   - In non-strict mode (the default today), validation mismatches log and
//     don't throw; the per-handler zod schemas still own the contract.
//   - LEXICON_STRICT=true flips both validateInbound and validateOutbound
//     into hard-rejection mode.
//
// We use `com.atproto.server.createSession` as a known lexicon — its main
// def is a `procedure` with input.encoding=application/json, a required
// `identifier` + `password`, and an output schema.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { validateInbound, validateOutbound } from './lexicon-bridge'

const KNOWN_NSID = 'com.atproto.server.createSession'

const validInput = () => ({
  identifier: 'alice.test',
  password: 'correct horse battery staple',
})

const invalidInput = () => ({
  // `identifier` missing → required-field failure
  password: 42, // wrong type, in case the validator reports several issues
})

// Console.warn is the soft-fail signal in non-strict mode. We spy on it to
// confirm the path runs without throwing.
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
  delete process.env.LEXICON_STRICT
})

describe('validateInbound', () => {
  it('passes a valid payload for a known NSID', async () => {
    await expect(
      validateInbound(KNOWN_NSID, { input: validInput(), params: {} }),
    ).resolves.toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown NSID', async () => {
    await expect(
      validateInbound('com.example.does.not.exist', {
        input: { anything: true },
        params: {},
      }),
    ).resolves.toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('logs but does not throw on a bad payload in non-strict mode', async () => {
    await expect(
      validateInbound(KNOWN_NSID, { input: invalidInput(), params: {} }),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(msg).toContain('lexicon:input')
    expect(msg).toContain(KNOWN_NSID)
  })

  it('throws on a bad payload in strict mode', async () => {
    process.env.LEXICON_STRICT = 'true'
    await expect(
      validateInbound(KNOWN_NSID, { input: invalidInput(), params: {} }),
    ).rejects.toThrow()
  })
})

describe('validateOutbound', () => {
  // A valid createSession output needs accessJwt, refreshJwt, handle, did.
  const validOutput = () => ({
    accessJwt: 'a.b.c',
    refreshJwt: 'd.e.f',
    handle: 'alice.test',
    did: 'did:plc:abcdefghijklmnopqrstuvwx',
  })
  const malformedOutput = () => ({
    accessJwt: 'a.b.c',
    // refreshJwt + handle + did missing → required-field failures
  })

  it('passes a valid output payload', async () => {
    await expect(
      validateOutbound(KNOWN_NSID, validOutput()),
    ).resolves.toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('passes Response objects through unchanged (binary handlers)', async () => {
    const res = new Response('not json', { status: 200 })
    await expect(validateOutbound(KNOWN_NSID, res)).resolves.toBeUndefined()
  })

  it('throws on a malformed output in strict mode', async () => {
    process.env.LEXICON_STRICT = 'true'
    await expect(
      validateOutbound(KNOWN_NSID, malformedOutput()),
    ).rejects.toThrow()
  })

  it('logs but does not throw on a malformed output in non-strict mode', async () => {
    await expect(
      validateOutbound(KNOWN_NSID, malformedOutput()),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })
})
