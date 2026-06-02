// Process-wide PDS configuration, read from environment.
//
// Read lazily on first access so the docs site loads even if PDS env vars
// aren't set yet (e.g. on a fresh clone). XRPC handlers that need them will
// throw on first use with a clear message.

import { hexToBytes } from '@noble/hashes/utils'

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
  cached = {
    publicUrl: publicUrl.replace(/\/$/, ''),
    hostname,
    serviceDid: `did:web:${hostname}`,
    jwtSecret: hexToBytes(jwtSecretHex),
    localPlcOnly: process.env.PDS_LOCAL_PLC !== 'false',
    blobStoreKind,
    blobStoreDir: required('BLOB_DIR', './.blobs'),
  }
  return cached
}

function required(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v && v.length > 0) return v
  if (fallback !== undefined) return fallback
  throw new Error(`missing required env var: ${name}`)
}
