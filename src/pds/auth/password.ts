// Password hashing.
//
// We use scrypt via node:crypto because it has zero native dependencies and
// runs in every Node runtime we target. Argon2id would be the modern pick,
// but it requires a native build (or wasm) that we don't want in the
// teaching surface. Parameters here are conservative; bump N for production.
//
// Hash format (versioned, so we can rotate parameters without rewriting
// stored hashes):
//   scrypt:v1:<N>:<r>:<p>:<salt-base64>:<hash-base64>

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>

const PARAMS = { N: 1 << 15, r: 8, p: 1 } // ~32 MB, ~150ms on modern HW
const KEY_LEN = 64
const SALT_LEN = 16

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters')
  }
  const salt = randomBytes(SALT_LEN)
  const hash = await scryptAsync(password, salt, KEY_LEN, {
    ...PARAMS,
    maxmem: 64 * 1024 * 1024,
  })
  return [
    'scrypt',
    'v1',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join(':')
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') {
    return false
  }
  const N = Number(parts[2])
  const r = Number(parts[3])
  const p = Number(parts[4])
  const salt = Buffer.from(parts[5]!, 'base64')
  const expected = Buffer.from(parts[6]!, 'base64')
  const computed = await scryptAsync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  })
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  )
}
