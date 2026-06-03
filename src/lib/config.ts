// Process-wide PDS configuration, read from environment.
//
// Read lazily on first access so the docs site loads even if PDS env vars
// aren't set yet (e.g. on a fresh clone). XRPC handlers that need them will
// throw on first use with a clear message.

import { hexToBytes } from '@noble/hashes/utils'

import type { LogLevel } from './logger'

export type PdsConfig = {
  publicUrl: string // e.g. https://pds.example.com
  hostname: string // e.g. pds.example.com
  serviceDid: string // did:web:<hostname>
  jwtSecret: Uint8Array // 64 random bytes for HS256
  /** When true (default in dev), we don't publish PLC ops to plc.directory.
   *  See chapter 12. */
  localPlcOnly: boolean
  /** Blob storage backend: 'filesystem' (default) or 's3' (stub). Ch. 15. */
  blobStoreKind: 'filesystem' | 's3'
  /** Root directory for the filesystem blob store (ignored for s3). */
  blobStoreDir: string
  /** Scrypt hash of the operator-admin password, or null to disable the
   *  com.atproto.admin.* surface entirely. See chapter 19. */
  adminPasswordHash: string | null
  /** When true, createAccount rejects without a valid `inviteCode`. Default
   *  false (open signup). See chapter 12 — Invite codes. */
  inviteRequired: boolean
  /** Hex-encoded 32-byte k256 private scalar used to sign OAuth tokens
   *  (access + refresh) and as the JWK published at /oauth/jwks. Separate
   *  from per-account repo keys: the PDS-as-issuer signs with this, the
   *  PDS-as-repo-host signs commits with the account's own key. NULL when
   *  the OAuth surface is disabled. See chapter 21 — OAuth. */
  oauthSigningKey: string | null
  /** Minimum log level for `src/lib/logger.ts`. Default 'info'. Set via
   *  `PDS_LOG_LEVEL=debug` etc. See chapter 18. */
  logLevel: LogLevel
  /** When true, the `/metrics` endpoint serves Prometheus exposition.
   *  Default false — scrape endpoints are sensitive; opt in deliberately and
   *  wrap them behind a reverse proxy ACL. See chapter 18. */
  metricsEnabled: boolean
  /** Backend for the DPoP `jti` replay store. 'in-memory' (default) is a
   *  single-process Map; 'redis' selects the stub backend that documents
   *  the SETNX EX 60 pattern but throws on first use. Wire a real Redis
   *  client in if you run multi-replica. See chapter 21 — OAuth. */
  dpopReplayStoreKind: 'in-memory' | 'redis'
  /** Handle of the account that gates the /admin web UI. When null, /admin
   *  is disabled (it 404s). When set, the operator logs in as their own
   *  account through the regular session flow; /admin then checks the
   *  current handle matches this env value. See chapter 19. */
  adminHandle: string | null
}

let cached: PdsConfig | null = null

export function getConfig(): PdsConfig {
  if (cached) return cached
  const publicUrl = required('PDS_PUBLIC_URL', 'http://localhost:3000')
  const hostname = required(
    'PDS_HOSTNAME',
    new URL(publicUrl).hostname || 'localhost',
  )
  const jwtSecretHex = required('PDS_JWT_SECRET')
  if (!/^[0-9a-fA-F]+$/.test(jwtSecretHex) || jwtSecretHex.length < 64) {
    throw new Error(
      'PDS_JWT_SECRET must be hex-encoded and at least 32 bytes (64 hex chars). ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"",
    )
  }
  const blobStoreKind: 'filesystem' | 's3' =
    process.env.BLOB_STORE === 's3' ? 's3' : 'filesystem'
  // Prefer the pre-hashed env var: an operator generates the hash once via
  // `pnpm admin:hash <password>` and pastes the result. The plaintext fallback
  // exists for quick local poking and is documented as such in chapter 19.
  const adminPasswordHash = resolveAdminPasswordHash()
  const oauthSigningKey = resolveOauthSigningKey()
  cached = {
    publicUrl: publicUrl.replace(/\/$/, ''),
    hostname,
    serviceDid: `did:web:${hostname}`,
    jwtSecret: hexToBytes(jwtSecretHex),
    localPlcOnly: process.env.PDS_LOCAL_PLC !== 'false',
    blobStoreKind,
    blobStoreDir: required('BLOB_DIR', './.blobs'),
    adminPasswordHash,
    inviteRequired: process.env.PDS_INVITE_REQUIRED !== 'false',
    oauthSigningKey,
    logLevel: resolveLogLevel(),
    metricsEnabled: process.env.PDS_METRICS === 'true',
    dpopReplayStoreKind:
      process.env.PDS_DPOP_REPLAY_STORE === 'redis' ? 'redis' : 'in-memory',
    adminHandle: resolveAdminHandle(),
  }
  return cached
}

function resolveLogLevel(): LogLevel {
  const raw = (process.env.PDS_LOG_LEVEL ?? '').toLowerCase()
  if (
    raw === 'trace' ||
    raw === 'debug' ||
    raw === 'info' ||
    raw === 'warn' ||
    raw === 'error' ||
    raw === 'fatal'
  ) {
    return raw
  }
  return 'info'
}

function resolveOauthSigningKey(): string | null {
  const hex = process.env.PDS_OAUTH_SIGNING_KEY
  if (!hex || hex.length === 0) return null
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== 64) {
    throw new Error(
      'PDS_OAUTH_SIGNING_KEY must be a 32-byte hex string (64 hex chars). ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    )
  }
  return hex.toLowerCase()
}

function resolveAdminPasswordHash(): string | null {
  const preHashed = process.env.PDS_ADMIN_PASSWORD_HASH
  if (preHashed && preHashed.length > 0) {
    if (!preHashed.startsWith('scrypt:v1:')) {
      throw new Error(
        'PDS_ADMIN_PASSWORD_HASH must be a scrypt:v1: string from `pnpm admin:hash`',
      )
    }
    return preHashed
  }
  // Plaintext fallback: log a warning, lazily hash on first auth. We don't
  // hash here because getConfig() is synchronous and hashPassword is async;
  // instead, requireAdmin caches the derived hash via this same field after
  // first verify. Returned as a sentinel-prefixed string the middleware
  // recognises.
  const plain = process.env.PDS_ADMIN_PASSWORD
  if (plain && plain.length > 0) return `plain:${plain}`
  return null
}

function resolveAdminHandle(): string | null {
  const raw = process.env.PDS_ADMIN_HANDLE
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0) return null
  return trimmed
}

function required(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v && v.length > 0) return v
  if (fallback !== undefined) return fallback
  throw new Error(`missing required env var: ${name}`)
}
