// plc.directory client.
//
// Wires the OFF-path of `PDS_LOCAL_PLC`. When `localPlcOnly` is true (the
// dev default) every function here is a no-op and we never touch the
// network — tests and the docs site rely on that. When false we publish
// signed PLC ops and fetch DID documents over HTTPS.
//
// See chapter 12 — Account creation, and chapter 18 — Production.

import { decode } from '~/pds/codec'
import { getConfig } from '~/lib/config'
import type { DidDocument } from './document'
import type { SignedPlcOp } from './plc'
import { BadRequest } from '~/pds/xrpc/errors'

const PLC_DIRECTORY = 'https://plc.directory'

/** POST a signed PLC op to plc.directory. No-op when `localPlcOnly`.
 *
 *  Retry policy: one network/5xx retry with a 250 ms backoff before throwing.
 *  409 is treated as success (idempotency on a prior timed-out attempt).
 *  400 surfaces as `InvalidRequest` so the caller's rollback fires. */
export async function publishPlcOp(args: {
  did: string
  signedOpBytes: Uint8Array
}): Promise<void> {
  if (getConfig().localPlcOnly) return

  // plc.directory accepts JSON, not DAG-CBOR. The signature was made over the
  // unsigned DAG-CBOR bytes — those bytes never travel; the directory
  // recomputes the CID from the canonical JSON form and (per PLC spec) the
  // two encodings hash to the same DID. If they don't, the directory rejects
  // with 400 and we surface the body for debugging.
  const signed = await decode<SignedPlcOp>(args.signedOpBytes)
  const body = JSON.stringify(signed)
  const url = `${PLC_DIRECTORY}/${encodeURIComponent(args.did)}`

  await postWithOneRetry(url, body)
}

async function postWithOneRetry(url: string, body: string): Promise<void> {
  try {
    await postOnce(url, body)
    return
  } catch (err) {
    if (!isRetryable(err)) throw err
    await new Promise((r) => setTimeout(r, 250))
    await postOnce(url, body)
  }
}

async function postOnce(url: string, body: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch (err) {
    // Network-level failure (DNS, connection reset, etc).
    throw new PlcPublishError('network error contacting plc.directory', {
      retryable: true,
      cause: err,
    })
  }

  if (res.ok) return
  if (res.status === 409) return // already published — idempotent success

  const text = await res.text().catch(() => '')
  if (res.status === 400) {
    // Validation failure — log enough to debug, then surface.
    console.error('[plc] 400 from plc.directory:', text)
    throw BadRequest(
      `plc.directory rejected op: ${text || res.statusText}`,
      'InvalidRequest',
    )
  }
  // 5xx (or any other non-2xx) — retryable.
  throw new PlcPublishError(
    `plc.directory ${res.status}: ${text || res.statusText}`,
    { retryable: res.status >= 500 },
  )
}

class PlcPublishError extends Error {
  retryable: boolean
  constructor(
    msg: string,
    opts: { retryable: boolean; cause?: unknown },
  ) {
    super(msg)
    this.name = 'PlcPublishError'
    this.retryable = opts.retryable
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause
  }
}

function isRetryable(err: unknown): boolean {
  return err instanceof PlcPublishError && err.retryable
}

/** Fetch a DID document for `did:plc:...` from plc.directory. Returns null
 *  on 404 so the resolver can negative-cache the miss. Throws on transport
 *  or unexpected upstream errors so the caller can retry. */
export async function fetchPlcDoc(did: string): Promise<DidDocument | null> {
  const url = `${PLC_DIRECTORY}/${encodeURIComponent(did)}`
  const res = await fetch(url, {
    headers: { accept: 'application/did+ld+json, application/json' },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`plc.directory ${res.status} fetching ${did}`)
  }
  return (await res.json()) as DidDocument
}

/** Fetch a DID document for `did:web:<host>` from the well-known URL.
 *  The host portion is percent-decoded per the did:web spec (`:` in a
 *  did:web identifier means a path segment). Returns null on 404. */
export async function fetchWebDoc(did: string): Promise<DidDocument | null> {
  const suffix = did.slice('did:web:'.length)
  if (!suffix) {
    throw new Error(`malformed did:web: ${did}`)
  }
  const parts = suffix.split(':').map((p) => decodeURIComponent(p))
  const host = parts[0]
  if (!host) {
    throw new Error(`malformed did:web: ${did}`)
  }
  const rest = parts.slice(1)
  const path =
    rest.length === 0
      ? '/.well-known/did.json'
      : `/${rest.join('/')}/did.json`
  const url = `https://${host}${path}`
  const res = await fetch(url, {
    headers: { accept: 'application/did+ld+json, application/json' },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`)
  }
  return (await res.json()) as DidDocument
}
