// TID — Timestamp IDentifier.
//
// 13 characters of sortable base32 encoding a 64-bit integer:
//   bit 0          : always 0 (high bit unset → positive when interpreted signed)
//   bits 1..53     : microseconds since Unix epoch (53 bits ≈ 285 years)
//   bits 54..63    : 10-bit clock identifier, randomized once per process
//
// TIDs sort lexicographically in time order, which is exactly what the MST
// wants for record keys. See chapter 06.

const ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'

// One clock identifier per process; picked once at startup. With 10 bits we
// have 1024 possible IDs, so two processes that pick the same one (~0.1%
// chance) only collide if they also generate at the same microsecond. We
// don't try to coordinate; the firehose's per-PDS sequence number is the
// authority for ordering events across writers.
const CLOCK_ID = Math.floor(Math.random() * 0x3ff)

// Microsecond counter that never goes backwards even if the wall clock does
// (NTP step, container restart, etc).
let lastUs = 0n

function nowMicros(): bigint {
  const ms = BigInt(Date.now())
  let us = ms * 1000n
  if (us <= lastUs) us = lastUs + 1n
  lastUs = us
  return us
}

/** Generate the next TID. Monotonic within a process. */
export function nextTid(): string {
  const us = nowMicros()
  const value = (us & ((1n << 53n) - 1n)) << 10n | BigInt(CLOCK_ID)
  return encodeS32(value)
}

/** Parse a TID back into its microsecond component (drops clock id). */
export function tidToMicros(tid: string): bigint {
  return decodeS32(tid) >> 10n
}

/** Encode a 63-bit unsigned integer as 13 chars of sortable base32. */
function encodeS32(n: bigint): string {
  let out = ''
  for (let i = 0; i < 13; i++) {
    const idx = Number(n & 0x1fn)
    out = ALPHABET[idx]! + out
    n >>= 5n
  }
  return out
}

function decodeS32(s: string): bigint {
  if (s.length !== 13) throw new Error(`invalid TID length: ${s.length}`)
  let n = 0n
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch)
    if (i === -1) throw new Error(`invalid TID character: ${ch}`)
    n = (n << 5n) | BigInt(i)
  }
  return n
}

const TID_RE = /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/

export function isValidTid(s: string): boolean {
  return TID_RE.test(s)
}
