// At-rest signing-key protection — see chapter 18.
//
// Per-account k256 private scalars (signing + rotation) live in
// `accounts.signing_key_priv` and `accounts.rotation_key_priv`. In dev they're
// stored as bare hex, which is fine for inspecting the flow with one SELECT
// but unacceptable in production: a DB dump steals every user's repo signing
// key.
//
// This module wraps the stored form with a *versioned prefix*. The on-disk
// shape becomes:
//
//   plain:<64-hex-chars>                 — no wrap (default; dev)
//   gcm:<base64url(nonce || ct || tag)>  — AES-256-GCM with a shared key
//   kms:<keyId>:<base64url(blob)>        — stub: real swap in production
//
// `wrap` produces a string in the configured backend's format. `unwrap`
// inspects the prefix and dispatches — any backend can read another's
// format, as long as the runtime has the relevant secrets configured. That
// means a PDS that flips `PDS_KEY_WRAP=plain → gcm` mid-lifetime can keep
// serving both the old `plain:` rows and the new `gcm:` rows side-by-side.
// `scripts/pds-admin.ts reencrypt-keys` walks the table to bring laggards
// over.
//
// Backward compat: rows written before this module landed have *no* prefix
// (they're a bare hex string). `unwrap` treats prefix-less input as plain.
// No schema migration — the format change is in-place.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

export interface KeyWrapper {
  /** Wrap a plaintext hex private scalar into the configured stored form.
   *  Idempotent on already-wrapped input: passing `'plain:abc...'` or
   *  `'gcm:...'` returns the same string. Callers don't have to know
   *  whether a given column value is already wrapped. */
  wrap(plainHex: string): Promise<string>

  /** Unwrap a stored form back to the bare hex private scalar. Inspects the
   *  prefix to choose a backend; prefix-less input is treated as a bare hex
   *  value (the pre-wrapping legacy format). Throws if the prefix names a
   *  backend whose secrets aren't configured. */
  unwrap(stored: string): Promise<string>
}

// ─── prefix detection ───────────────────────────────────────────────────
//
// A stored value matches one of:
//   - prefix-less bare hex (legacy)
//   - 'plain:<hex>'
//   - 'gcm:<b64u>'
//   - 'kms:<keyId>:<b64u>'
//
// We split on the first colon. Anything that doesn't look like a known
// prefix is assumed to be bare hex — same as the legacy format.

const HEX_RE = /^[0-9a-f]+$/i

type StoredForm =
  | { kind: 'plain'; hex: string }
  | { kind: 'gcm'; payload: string }
  | { kind: 'kms'; payload: string }
  | { kind: 'bare-hex'; hex: string }

function classify(stored: string): StoredForm {
  if (stored.startsWith('plain:')) {
    return { kind: 'plain', hex: stored.slice('plain:'.length) }
  }
  if (stored.startsWith('gcm:')) {
    return { kind: 'gcm', payload: stored.slice('gcm:'.length) }
  }
  if (stored.startsWith('kms:')) {
    return { kind: 'kms', payload: stored.slice('kms:'.length) }
  }
  return { kind: 'bare-hex', hex: stored }
}

function isAlreadyWrapped(stored: string): boolean {
  return (
    stored.startsWith('plain:') ||
    stored.startsWith('gcm:') ||
    stored.startsWith('kms:')
  )
}

// ─── plain backend ──────────────────────────────────────────────────────

export class PlainKeyWrapper implements KeyWrapper {
  async wrap(plainHex: string): Promise<string> {
    if (isAlreadyWrapped(plainHex)) return plainHex
    return 'plain:' + plainHex
  }
  async unwrap(stored: string): Promise<string> {
    return unwrapDispatch(stored, this)
  }
}

// ─── gcm backend ────────────────────────────────────────────────────────
//
// AES-256-GCM with a fresh 12-byte nonce per wrap. The 16-byte auth tag
// covers ciphertext + nonce, so any tampering trips a `decipher.final()`
// throw. We concatenate nonce || ciphertext || tag and base64url-encode
// the lot — one column write, one parse on read. No new dependency
// (`node:crypto` is in the standard library); see chapter 18 for the
// rationale on picking GCM over a real `age`-format implementation.

const GCM_NONCE_LEN = 12
const GCM_TAG_LEN = 16
const GCM_KEY_LEN = 32

export class GcmKeyWrapper implements KeyWrapper {
  constructor(private readonly key32: Uint8Array) {
    if (key32.length !== GCM_KEY_LEN) {
      throw new Error(
        `GcmKeyWrapper requires a ${GCM_KEY_LEN}-byte key, got ${key32.length}`,
      )
    }
  }

  async wrap(plainHex: string): Promise<string> {
    if (isAlreadyWrapped(plainHex)) return plainHex
    const nonce = randomBytes(GCM_NONCE_LEN)
    const cipher = createCipheriv('aes-256-gcm', this.key32, nonce)
    const ct = Buffer.concat([
      cipher.update(Buffer.from(plainHex, 'utf8')),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    const combined = Buffer.concat([nonce, ct, tag])
    return 'gcm:' + toBase64Url(combined)
  }

  async unwrap(stored: string): Promise<string> {
    return unwrapDispatch(stored, this)
  }

  /** Internal: undo a `gcm:` payload. Throws on auth-tag failure. */
  decrypt(payload: string): string {
    const combined = fromBase64Url(payload)
    if (combined.length < GCM_NONCE_LEN + GCM_TAG_LEN) {
      throw new Error('gcm payload is too short to contain nonce + tag')
    }
    const nonce = combined.subarray(0, GCM_NONCE_LEN)
    const tag = combined.subarray(combined.length - GCM_TAG_LEN)
    const ct = combined.subarray(GCM_NONCE_LEN, combined.length - GCM_TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', this.key32, nonce)
    decipher.setAuthTag(tag)
    const out = Buffer.concat([decipher.update(ct), decipher.final()])
    return out.toString('utf8')
  }
}

// ─── kms backend (stub) ──────────────────────────────────────────────────
//
// Reserved for a future swap to AWS KMS / Google Cloud KMS / HashiCorp Vault.
// The shape would be envelope encryption: a KMS-resident wrapping key, a
// per-row data key, ciphertext stored alongside. The audit-log advantage
// over `gcm` is the point — every unwrap shows up as a KMS API call, so a
// stolen DB dump alone can't sign for an account.
//
// We don't implement it. Selecting `kms` at startup throws with a clear
// chapter pointer. `unwrap` still handles foreign prefixes (e.g. a row
// that happens to be `plain:` or `gcm:`) so mixed-mode reads work after
// rotation away from kms — but anything actually marked `kms:` errors.

export class KmsKeyWrapper implements KeyWrapper {
  async wrap(plainHex: string): Promise<string> {
    void plainHex
    throw new Error(stubMessage())
  }

  async unwrap(stored: string): Promise<string> {
    if (stored.startsWith('kms:')) throw new Error(stubMessage())
    return unwrapDispatch(stored, this)
  }
}

function stubMessage(): string {
  return (
    'KMS backend not implemented in teaching port — see chapter 18 ' +
    '(production › Signing keys › KeyWrapper) for the production swap.'
  )
}

// ─── shared dispatch ────────────────────────────────────────────────────
//
// Every concrete backend's `unwrap` funnels through here. The classifier
// looks at the prefix and decides which path can decode it, regardless of
// which backend is currently configured. That's what makes mixed-mode
// rows work without an offline rewrite: an operator flips
// `PDS_KEY_WRAP=plain → gcm`, fresh accounts land as `gcm:`, existing
// accounts stay `plain:` until `pds-admin reencrypt-keys` rewrites them.

function unwrapDispatch(stored: string, self: KeyWrapper): Promise<string> {
  const parsed = classify(stored)
  switch (parsed.kind) {
    case 'plain':
    case 'bare-hex':
      return Promise.resolve(parsed.hex)
    case 'gcm':
      return Promise.resolve(unwrapGcmFor(self, parsed.payload))
    case 'kms':
      throw new Error(stubMessage())
  }
}

// A GCM-encrypted row can only be read by a GcmKeyWrapper — the symmetric
// key isn't in the prefix. If the configured wrapper isn't gcm, we can't
// fulfil the request and surface a clear error so the operator knows to
// set `PDS_KEY_WRAP=gcm` (and the matching key env var) before retrying.
function unwrapGcmFor(self: KeyWrapper, payload: string): string {
  if (self instanceof GcmKeyWrapper) return self.decrypt(payload)
  throw new Error(
    "encountered a 'gcm:' wrapped key but the configured wrapper is not " +
      'gcm — set PDS_KEY_WRAP=gcm (and PDS_KEY_WRAP_GCM_KEY) to read this row',
  )
}

// ─── selector ───────────────────────────────────────────────────────────

let cached: KeyWrapper | null = null

/** Build the configured wrapper from env. Cached, like getConfig(). Call
 *  `resetKeyWrapperCacheForTests()` between tests that mutate the env. */
export function getKeyWrapper(): KeyWrapper {
  if (cached) return cached
  const kind = (process.env.PDS_KEY_WRAP ?? 'plain').toLowerCase()
  switch (kind) {
    case 'plain':
      cached = new PlainKeyWrapper()
      return cached
    case 'gcm': {
      const hex = process.env.PDS_KEY_WRAP_GCM_KEY ?? ''
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(
          'PDS_KEY_WRAP_GCM_KEY must be a 32-byte hex string (64 hex chars). ' +
            "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
        )
      }
      cached = new GcmKeyWrapper(hexToBytes(hex))
      return cached
    }
    case 'kms':
      throw new Error(stubMessage())
    default:
      throw new Error(
        `unknown PDS_KEY_WRAP=${kind}; expected one of: plain, gcm, kms`,
      )
  }
}

/** Test-only: clear the memoised wrapper so the next `getKeyWrapper()` re-
 *  reads `process.env`. The production path never needs this — env vars
 *  are read once at startup. */
export function resetKeyWrapperCacheForTests(): void {
  cached = null
}

// ─── helpers ────────────────────────────────────────────────────────────

function toBase64Url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url')
}

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = hex.slice(i * 2, i * 2 + 2)
    out[i] = Number.parseInt(byte, 16)
  }
  return out
}
