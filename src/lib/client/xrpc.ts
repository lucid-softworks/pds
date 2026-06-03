// Browser-side XRPC client for the in-repo Bluesky client at /app.
//
// One thin function — `xrpcCall` — that wraps `fetch`:
//
//   - serializes params (GET) / JSON body (POST),
//   - attaches `Authorization: Bearer <accessJwt>` when `auth: true`,
//   - on 401 ExpiredToken: hits refreshSession, swaps the stored pair, and
//     replays the original call exactly once,
//   - on every other XRPC error: throws an `XrpcError` carrying the upstream
//     error code + message so views can render something useful.
//
// The views import this and never touch `fetch` directly. That keeps the
// session-refresh logic in one place and stops the JWTs from leaking into
// component code. See chapter 22 for the why.

import { clearSession, getSession, setSession, type Session } from './session'

export type XrpcMethod = 'GET' | 'POST'

export type XrpcOptions = {
  method?: XrpcMethod
  /** Body for POST. JSON-serialized. */
  input?: unknown
  /** Querystring params for GET (or POST). */
  params?: Record<string, string | number | boolean | undefined>
  /** Attach Authorization header from the stored session. */
  auth?: boolean
}

export class XrpcError extends Error {
  status: number
  errorCode: string | undefined
  constructor(status: number, errorCode: string | undefined, message: string) {
    super(message)
    this.name = 'XrpcError'
    this.status = status
    this.errorCode = errorCode
  }
}

export async function xrpcCall<T = unknown>(
  nsid: string,
  opts: XrpcOptions = {},
): Promise<T> {
  const method: XrpcMethod = opts.method ?? (opts.input !== undefined ? 'POST' : 'GET')
  const url = buildUrl(nsid, opts.params)

  let res = await doFetch(url, method, opts.input, opts.auth ? getSession() : null)

  // If we hit ExpiredToken, try to refresh once and replay.
  if (res.status === 401 && opts.auth) {
    const body = await peekBody(res)
    if (isExpiredToken(body)) {
      const refreshed = await tryRefresh()
      if (refreshed) {
        res = await doFetch(url, method, opts.input, refreshed)
      } else {
        // Refresh itself failed — the session is dead. Clear and bubble up
        // an error so the view layer can redirect to /app.
        clearSession()
        throw new XrpcError(401, 'ExpiredToken', 'Session expired. Please log in again.')
      }
    }
  }

  return readResponse<T>(res)
}

function buildUrl(
  nsid: string,
  params: XrpcOptions['params'],
): string {
  const u = new URL(`/xrpc/${nsid}`, currentOrigin())
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue
      u.searchParams.set(k, String(v))
    }
  }
  return u.toString()
}

// In the browser we have a real origin; in tests (jsdom-less) we fall back to
// a stub. The integration tests for xrpc.ts use a global `fetch` mock and
// don't care about the URL host.
function currentOrigin(): string {
  if (typeof window !== 'undefined' && window.location) return window.location.origin
  return 'http://localhost'
}

async function doFetch(
  url: string,
  method: XrpcMethod,
  input: unknown,
  auth: Session | null,
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (input !== undefined) headers['content-type'] = 'application/json'
  if (auth) headers['authorization'] = `Bearer ${auth.accessJwt}`
  const init: RequestInit = { method, headers }
  if (input !== undefined) init.body = JSON.stringify(input)
  return fetch(url, init)
}

async function peekBody(res: Response): Promise<unknown> {
  // Clone before reading — callers downstream may want to read it too.
  // (We then throw away `res` and re-parse via readResponse if needed.)
  try {
    return await res.clone().json()
  } catch {
    return null
  }
}

function isExpiredToken(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const error = (body as { error?: unknown }).error
  return error === 'ExpiredToken'
}

async function tryRefresh(): Promise<Session | null> {
  const current = getSession()
  if (!current) return null
  const url = new URL('/xrpc/com.atproto.server.refreshSession', currentOrigin()).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${current.refreshJwt}` },
  })
  if (!res.ok) return null
  let data: {
    did?: unknown
    handle?: unknown
    accessJwt?: unknown
    refreshJwt?: unknown
  }
  try {
    data = (await res.json()) as typeof data
  } catch {
    return null
  }
  if (
    typeof data.did !== 'string' ||
    typeof data.handle !== 'string' ||
    typeof data.accessJwt !== 'string' ||
    typeof data.refreshJwt !== 'string'
  ) {
    return null
  }
  const next: Session = {
    did: data.did,
    handle: data.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
  }
  setSession(next)
  return next
}

/**
 * Upload binary bytes to com.atproto.repo.uploadBlob and return the
 * lexicon-shaped blob ref. Mirrors `xrpcCall`'s expired-token-then-refresh
 * loop: if the access JWT is rejected, refresh once and replay; if refresh
 * itself fails, clear the session and throw an ExpiredToken XrpcError.
 *
 * We split this out from `xrpcCall` instead of overloading the input field
 * because the body here is a raw `Uint8Array` with the file's MIME type as
 * Content-Type — there's no JSON envelope. Browsers will set Content-Length
 * automatically; we don't need to chunk for a 1 MB cap.
 */
export type BlobRef = {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

export async function xrpcUploadBlob(args: {
  bytes: Uint8Array
  mimeType: string
  auth: Session
}): Promise<BlobRef> {
  const url = buildUrl('com.atproto.repo.uploadBlob', undefined)

  let res = await doUpload(url, args.bytes, args.mimeType, args.auth)

  if (res.status === 401) {
    const body = await peekBody(res)
    if (isExpiredToken(body)) {
      const refreshed = await tryRefresh()
      if (refreshed) {
        res = await doUpload(url, args.bytes, args.mimeType, refreshed)
      } else {
        clearSession()
        throw new XrpcError(401, 'ExpiredToken', 'Session expired. Please log in again.')
      }
    }
  }

  const out = await readResponse<{ blob: BlobRef }>(res)
  return out.blob
}

async function doUpload(
  url: string,
  bytes: Uint8Array,
  mimeType: string,
  auth: Session,
): Promise<Response> {
  // `fetch` accepts ArrayBuffer/ArrayBufferView for the body; we hand it the
  // Uint8Array's underlying buffer slice so we don't copy. The BodyInit type
  // is wider than the runtime expects in some lib targets, so we narrow via
  // a `BufferSource` cast.
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': mimeType,
      authorization: `Bearer ${auth.accessJwt}`,
    },
    body: bytes as BufferSource,
  })
}

async function readResponse<T>(res: Response): Promise<T> {
  // No-content (204 etc.) — return undefined cast as T. Callers asking for
  // void-returning endpoints (deleteSession) won't read it anyway.
  if (res.status === 204) return undefined as T

  const text = await res.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!res.ok) {
    const errorCode =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? ((body as { error: string }).error)
        : undefined
    const message =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? ((body as { message: string }).message)
        : `HTTP ${res.status}`
    throw new XrpcError(res.status, errorCode, message)
  }

  return body as T
}
