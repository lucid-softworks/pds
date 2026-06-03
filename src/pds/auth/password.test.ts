// Behavior contract for password hashing.
//
// Stored hashes follow the format `scrypt:v1:N:r:p:salt-b64:hash-b64`.
// `hashPassword` and `verifyPassword` are mutual inverses; any deviation
// breaks login for every account. The format is parsed in code (look for
// `parts.length !== 7`) and pinned here.

import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('hashPassword', () => {
  it('produces the scrypt:v1:N:r:p:salt:hash format', async () => {
    const hash = await hashPassword('correct horse')
    const parts = hash.split(':')
    expect(parts).toHaveLength(7)
    expect(parts[0]).toBe('scrypt')
    expect(parts[1]).toBe('v1')
    // N, r, p must be positive integers.
    expect(Number.parseInt(parts[2]!, 10)).toBeGreaterThan(0)
    expect(Number.parseInt(parts[3]!, 10)).toBeGreaterThan(0)
    expect(Number.parseInt(parts[4]!, 10)).toBeGreaterThan(0)
    // salt + hash must be non-empty base64 strings.
    expect(parts[5]!.length).toBeGreaterThan(0)
    expect(parts[6]!.length).toBeGreaterThan(0)
  })

  it('produces a distinct hash each call (random salt)', async () => {
    const a = await hashPassword('correct horse')
    const b = await hashPassword('correct horse')
    expect(a).not.toBe(b)
  })

  it('rejects passwords shorter than 8 characters', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 8/)
  })
})

describe('verifyPassword', () => {
  it('returns true for the correct password', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
  })

  it('returns false for the wrong password', async () => {
    const hash = await hashPassword('correct horse')
    expect(await verifyPassword('wrong horse', hash)).toBe(false)
  })

  it('returns false for a malformed hash string', async () => {
    // Wrong number of fields, wrong algorithm, wrong version — all return
    // false rather than throwing, so login flows stay constant-time-ish.
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('anything', 'scrypt:v2:1:1:1:aaaa:bbbb')).toBe(
      false,
    )
    expect(await verifyPassword('anything', 'argon2:v1:1:1:1:aaaa:bbbb')).toBe(
      false,
    )
  })
})
