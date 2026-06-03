// Behavior contract for the at-rest key wrapper.
//
// Stored format is `<prefix>:<payload>` (or bare hex for legacy rows).
// `wrap` produces the prefix; `unwrap` dispatches on it. Round-trips,
// idempotency, mixed-mode reads, and tamper-detection are all pinned here
// because every account's repo signature flows through these two calls.
//
// See chapter 18 — Signing keys.

import { describe, expect, it } from 'vitest'
import {
  GcmKeyWrapper,
  KmsKeyWrapper,
  PlainKeyWrapper,
  resetKeyWrapperCacheForTests,
  getKeyWrapper,
} from './key_wrap'

const HEX_PRIV =
  // 32 random bytes, hex — a plausible k256 private scalar shape.
  'abc1230000000000000000000000000000000000000000000000000000000001'

function hexKey32(): Uint8Array {
  return new Uint8Array(32).fill(0x42)
}

describe('PlainKeyWrapper', () => {
  it('wraps a bare hex value with the plain: prefix', async () => {
    const w = new PlainKeyWrapper()
    expect(await w.wrap(HEX_PRIV)).toBe('plain:' + HEX_PRIV)
  })

  it('round-trips wrap → unwrap', async () => {
    const w = new PlainKeyWrapper()
    const stored = await w.wrap(HEX_PRIV)
    expect(await w.unwrap(stored)).toBe(HEX_PRIV)
  })

  it('is idempotent on an already-wrapped plain: value', async () => {
    const w = new PlainKeyWrapper()
    const once = await w.wrap(HEX_PRIV)
    const twice = await w.wrap(once)
    expect(twice).toBe(once)
  })

  it('treats bare-hex legacy rows as plain on unwrap', async () => {
    // Rows written before key_wrap landed have no prefix. The dispatcher
    // must keep reading them so the format change is backward-compatible.
    const w = new PlainKeyWrapper()
    expect(await w.unwrap(HEX_PRIV)).toBe(HEX_PRIV)
  })
})

describe('GcmKeyWrapper', () => {
  it('round-trips wrap → unwrap with a 32-byte key', async () => {
    const w = new GcmKeyWrapper(hexKey32())
    const stored = await w.wrap(HEX_PRIV)
    expect(stored.startsWith('gcm:')).toBe(true)
    expect(await w.unwrap(stored)).toBe(HEX_PRIV)
  })

  it('produces a fresh nonce per wrap (ciphertexts differ)', async () => {
    const w = new GcmKeyWrapper(hexKey32())
    const a = await w.wrap(HEX_PRIV)
    const b = await w.wrap(HEX_PRIV)
    expect(a).not.toBe(b)
    expect(await w.unwrap(a)).toBe(HEX_PRIV)
    expect(await w.unwrap(b)).toBe(HEX_PRIV)
  })

  it('rejects a tampered ciphertext (auth tag catches the flip)', async () => {
    const w = new GcmKeyWrapper(hexKey32())
    const stored = await w.wrap(HEX_PRIV)
    // Flip a bit in the payload portion.
    const body = stored.slice('gcm:'.length)
    const flipped =
      'gcm:' + (body[0] === 'A' ? 'B' : 'A') + body.slice(1)
    await expect(w.unwrap(flipped)).rejects.toThrow()
  })

  it('rejects the wrong shared key', async () => {
    const a = new GcmKeyWrapper(new Uint8Array(32).fill(0x01))
    const b = new GcmKeyWrapper(new Uint8Array(32).fill(0x02))
    const stored = await a.wrap(HEX_PRIV)
    await expect(b.unwrap(stored)).rejects.toThrow()
  })

  it('rejects a non-32-byte key at construction', () => {
    expect(() => new GcmKeyWrapper(new Uint8Array(16))).toThrow(
      /32-byte key/,
    )
  })

  it('is idempotent on an already-wrapped gcm: value', async () => {
    const w = new GcmKeyWrapper(hexKey32())
    const once = await w.wrap(HEX_PRIV)
    const twice = await w.wrap(once)
    expect(twice).toBe(once)
  })

  // Mixed-mode reads: a gcm wrapper still has to unwrap a `plain:` row that
  // was written before the operator flipped `PDS_KEY_WRAP=plain → gcm`. The
  // dispatcher does this without holding any gcm secrets.
  it('mixed-mode: unwraps a plain: row produced by PlainKeyWrapper', async () => {
    const plain = new PlainKeyWrapper()
    const gcm = new GcmKeyWrapper(hexKey32())
    const stored = await plain.wrap(HEX_PRIV)
    expect(await gcm.unwrap(stored)).toBe(HEX_PRIV)
  })

  it('mixed-mode: unwraps a bare-hex legacy row', async () => {
    const gcm = new GcmKeyWrapper(hexKey32())
    expect(await gcm.unwrap(HEX_PRIV)).toBe(HEX_PRIV)
  })

  // The reverse direction: a plain wrapper can't decrypt a gcm row without
  // the symmetric key. Surface a clear error rather than returning garbage.
  it('plain wrapper rejects a gcm-wrapped row with a clear error', async () => {
    const gcm = new GcmKeyWrapper(hexKey32())
    const plain = new PlainKeyWrapper()
    const stored = await gcm.wrap(HEX_PRIV)
    await expect(plain.unwrap(stored)).rejects.toThrow(/PDS_KEY_WRAP=gcm/)
  })
})

describe('KmsKeyWrapper', () => {
  it('wrap() throws with the chapter pointer', async () => {
    const w = new KmsKeyWrapper()
    await expect(w.wrap(HEX_PRIV)).rejects.toThrow(/chapter 18/)
  })

  it('unwrap() throws on a kms: prefix', async () => {
    const w = new KmsKeyWrapper()
    await expect(w.unwrap('kms:my-key-id:abc')).rejects.toThrow(/chapter 18/)
  })

  // KmsKeyWrapper still has to read legacy plain: rows so an operator can't
  // get stuck during a migration *to* kms — anything not marked kms: passes
  // through the same dispatcher.
  it('unwrap() falls through to plain dispatch for non-kms prefixes', async () => {
    const w = new KmsKeyWrapper()
    expect(await w.unwrap('plain:' + HEX_PRIV)).toBe(HEX_PRIV)
    expect(await w.unwrap(HEX_PRIV)).toBe(HEX_PRIV)
  })
})

describe('getKeyWrapper', () => {
  // We tear-down + restore env in each test so the module cache is the only
  // moving part. The cache is shared across `getConfig` and friends, so we
  // reset before every assertion.

  it('defaults to plain when PDS_KEY_WRAP is unset', async () => {
    const saved = process.env.PDS_KEY_WRAP
    delete process.env.PDS_KEY_WRAP
    resetKeyWrapperCacheForTests()
    try {
      const w = getKeyWrapper()
      expect(w).toBeInstanceOf(PlainKeyWrapper)
    } finally {
      if (saved !== undefined) process.env.PDS_KEY_WRAP = saved
      resetKeyWrapperCacheForTests()
    }
  })

  it('builds a GcmKeyWrapper when configured', async () => {
    const saved = { ...process.env }
    process.env.PDS_KEY_WRAP = 'gcm'
    process.env.PDS_KEY_WRAP_GCM_KEY = '00'.repeat(32)
    resetKeyWrapperCacheForTests()
    try {
      const w = getKeyWrapper()
      expect(w).toBeInstanceOf(GcmKeyWrapper)
    } finally {
      Object.assign(process.env, saved)
      delete process.env.PDS_KEY_WRAP_GCM_KEY
      if (saved.PDS_KEY_WRAP === undefined) delete process.env.PDS_KEY_WRAP
      resetKeyWrapperCacheForTests()
    }
  })

  it('rejects a missing or malformed gcm key', async () => {
    const saved = { ...process.env }
    process.env.PDS_KEY_WRAP = 'gcm'
    delete process.env.PDS_KEY_WRAP_GCM_KEY
    resetKeyWrapperCacheForTests()
    try {
      expect(() => getKeyWrapper()).toThrow(/PDS_KEY_WRAP_GCM_KEY/)
      process.env.PDS_KEY_WRAP_GCM_KEY = 'not-hex'
      resetKeyWrapperCacheForTests()
      expect(() => getKeyWrapper()).toThrow(/PDS_KEY_WRAP_GCM_KEY/)
    } finally {
      Object.assign(process.env, saved)
      delete process.env.PDS_KEY_WRAP_GCM_KEY
      if (saved.PDS_KEY_WRAP === undefined) delete process.env.PDS_KEY_WRAP
      resetKeyWrapperCacheForTests()
    }
  })

  it('throws at startup when PDS_KEY_WRAP=kms', async () => {
    const saved = process.env.PDS_KEY_WRAP
    process.env.PDS_KEY_WRAP = 'kms'
    resetKeyWrapperCacheForTests()
    try {
      expect(() => getKeyWrapper()).toThrow(/chapter 18/)
    } finally {
      if (saved !== undefined) process.env.PDS_KEY_WRAP = saved
      else delete process.env.PDS_KEY_WRAP
      resetKeyWrapperCacheForTests()
    }
  })

  it('rejects an unknown backend name', async () => {
    const saved = process.env.PDS_KEY_WRAP
    process.env.PDS_KEY_WRAP = 'aes-cbc'
    resetKeyWrapperCacheForTests()
    try {
      expect(() => getKeyWrapper()).toThrow(/unknown PDS_KEY_WRAP/)
    } finally {
      if (saved !== undefined) process.env.PDS_KEY_WRAP = saved
      else delete process.env.PDS_KEY_WRAP
      resetKeyWrapperCacheForTests()
    }
  })
})
