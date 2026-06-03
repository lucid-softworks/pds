// Minimal XRPC dispatcher.
//
// Handlers register against an NSID; the dispatcher routes requests by NSID
// and translates thrown XrpcErrors into the `{ error, message }` envelope.
//
// Lexicon validation runs alongside the handler's hand-rolled zod schemas
// (see lexicon-bridge.ts). Today it's observe-only: mismatches log, the
// handler still owns the contract. Setting `LEXICON_STRICT=true` turns the
// observe-only check into a hard rejection. The plan for chapter 9's
// follow-up is to flip that env var once the log is clean.
//
// Every dispatched call emits one structured log line — `nsid`, `method`,
// `status`, `durationMs`, and (best-effort) the caller's `did` parsed
// without verification from the Authorization JWT — plus a `pds_xrpc_*`
// metric. Expected client errors (`XrpcError`) log at info; unexpected
// errors log at error with the stack on `err`.

import { getLogger } from '~/lib/logger'
import {
  rateLimitRejectedTotal,
  xrpcRequestDurationSeconds,
  xrpcRequestsTotal,
} from '~/lib/metrics'
import { requireEitherAuth } from '~/pds/auth/middleware'
import { XrpcError, InternalError, BadRequest, NotFound } from './errors'
import { validateInbound, validateOutbound } from './lexicon-bridge'
import { dispatchViaProxy } from './proxy'
import {
  callerIpFromRequest,
  getRateLimitStore,
  rateLimitFor,
} from './rate_limit'

const log = getLogger('xrpc')

export type HandlerCtx = {
  /** The parsed JSON body for procedures, or undefined for queries. */
  input: unknown
  /** Decoded query-string parameters, always defined (possibly empty). */
  params: Record<string, string>
  /** Whatever the request's Authorization header claimed, before validation. */
  authorization?: string
  /** The paired DPoP proof from the `DPoP:` request header, if any. Only
   *  meaningful for OAuth-scheme requests (`Authorization: DPoP <jwt>`); the
   *  legacy `Bearer` flow ignores it. Handlers that want to accept either
   *  scheme call `requireEitherAuth({ authorization, dpopProof, request })`. */
  dpopProof?: string
  /** The raw Request for handlers that need streaming or headers. */
  request: Request
}

export type Handler = (ctx: HandlerCtx) => Promise<unknown>

export type HandlerDef = {
  method: 'GET' | 'POST'
  handler: Handler
}

export class HandlerRegistry {
  private map = new Map<string, HandlerDef>()

  register(nsid: string, def: HandlerDef): this {
    this.map.set(nsid, def)
    return this
  }

  get(nsid: string): HandlerDef | undefined {
    return this.map.get(nsid)
  }
}

/** Decode the JSON body (or null if absent / wrong content-type). */
async function readJsonBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const ct = req.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().startsWith('application/json')) return undefined
  const text = await req.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw BadRequest('malformed JSON body')
  }
}

/** Dispatch a request to a registered handler, returning a Response. */
export async function dispatch(
  registry: HandlerRegistry,
  nsid: string,
  request: Request,
): Promise<Response> {
  const start = performance.now()
  const method = request.method
  const did = peekDidFromAuth(request.headers.get('authorization') ?? undefined)
  const reqLog = log.with({
    nsid,
    method,
    ...(did !== undefined ? { did } : {}),
  })

  const respond = (res: Response): Response => {
    const durationMs = performance.now() - start
    xrpcRequestsTotal.inc({ nsid, method, status: String(res.status) })
    xrpcRequestDurationSeconds.observe({ nsid, method }, durationMs / 1000)
    // Successful + expected-client-error paths are info; the 5xx path logs
    // at error from the catch below before we get here.
    if (res.status < 500) {
      reqLog.info('xrpc-request', { status: res.status, durationMs })
    }
    return res
  }

  // PDS-as-proxy: when the client sends `Atproto-Proxy: <did>#<svc>` AND
  // we don't have a local handler for the NSID, forward the call upstream
  // (typically the user's AppView / chat / labeler) signed with a fresh
  // service-auth JWT minted from their repo signing key. The header alone
  // is *not* enough to take the proxy branch — bsky.app sets it on every
  // request including `com.atproto.*` calls that we should handle locally;
  // proxying those would round-trip them to the AppView and get a 4xx.
  // See chapter 17 + src/pds/xrpc/proxy.ts.
  const def = registry.get(nsid)
  if (!def) {
    const proxyHeader = request.headers.get('atproto-proxy')
    if (proxyHeader) {
      try {
        const auth = await requireEitherAuth({
          authorization: request.headers.get('authorization') ?? undefined,
          dpopProof: request.headers.get('dpop') ?? undefined,
          request,
        })
        const res = await dispatchViaProxy({
          nsid,
          request,
          callerDid: auth.did,
        })
        return respond(res)
      } catch (err) {
        if (err instanceof XrpcError) return respond(jsonResponse(err))
        reqLog.error('xrpc-proxy-failed', {
          err: { name: (err as Error).name, message: (err as Error).message },
        })
        return respond(jsonResponse(InternalError()))
      }
    }
    return respond(
      jsonResponse(NotFound(`unknown XRPC method: ${nsid}`, 'MethodNotImplemented')),
    )
  }
  if (request.method !== def.method) {
    return respond(
      jsonResponse(
        BadRequest(
          `expected ${def.method} for ${nsid}, got ${request.method}`,
          'InvalidRequest',
        ),
      ),
    )
  }
  const url = new URL(request.url)
  const params = Object.fromEntries(url.searchParams.entries())

  try {
    const input = await readJsonBody(request)

    // Validate against the lexicon (observe-only unless LEXICON_STRICT=true).
    await validateInbound(nsid, { input, params })

    // Rate-limit gate. Sits between lexicon validation and the handler:
    // a malformed payload short-circuits without consuming a token (so a
    // misbehaving client gets 400s on its schema bug instead of having
    // its 5-per-5min reset-password budget spent), and a well-formed
    // payload only reaches the handler if there's capacity left.
    const limit = rateLimitFor(nsid, method)
    if (limit) {
      const ip = callerIpFromRequest(request)
      const key = `${ip}:${nsid}`
      const decision = await getRateLimitStore().check(key, limit)
      if (!decision.allowed) {
        rateLimitRejectedTotal.inc({ nsid })
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(decision.retryAfterMs / 1000),
        )
        reqLog.warn('xrpc-rate-limited', {
          ip,
          retryAfterSeconds,
          capacity: limit.capacity,
          windowMs: limit.windowMs,
        })
        return respond(
          new Response(
            JSON.stringify({
              error: 'RateLimitExceeded',
              message: `rate limit exceeded for ${nsid}`,
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(retryAfterSeconds),
              },
            },
          ),
        )
      }
    }

    const output = await def.handler({
      input,
      params,
      authorization: request.headers.get('authorization') ?? undefined,
      dpopProof: request.headers.get('dpop') ?? undefined,
      request,
    })

    // Binary handlers (e.g. sync.getRepo, sync.getBlob) build their own
    // Response so they can stream CAR / blob bytes; pass it through unchanged
    // rather than JSON-stringifying it.
    if (output instanceof Response) return respond(output)

    await validateOutbound(nsid, output)

    // Return `{}` rather than an empty body when the handler resolves to
    // `undefined` (lexicons without an `output` schema). Some atproto
    // clients call `response.json()` unconditionally and an empty body
    // would throw; `{}` parses to a no-op object.
    return respond(
      new Response(
        output === undefined ? '{}' : JSON.stringify(output),
        {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      ),
    )
  } catch (err) {
    if (err instanceof XrpcError) return respond(jsonResponse(err))
    const durationMs = performance.now() - start
    reqLog.error('xrpc-request-failed', {
      durationMs,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return respond(jsonResponse(InternalError()))
  }
}

function jsonResponse(err: XrpcError): Response {
  return new Response(JSON.stringify(err.toResponseBody()), {
    status: err.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Best-effort DID peek for logging. Decodes the JWT payload without verifying
 *  the signature — the handler does the real verification. Returns undefined
 *  for anything that doesn't look like a JWT with a `sub` claim. */
function peekDidFromAuth(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined
  const trimmed = authorization.trim()
  const match = /^(?:bearer|dpop)\s+(.+)$/i.exec(trimmed)
  if (!match || !match[1]) return undefined
  const token = match[1].trim()
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (!payload) return undefined
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const claims = JSON.parse(json) as { sub?: unknown; did?: unknown }
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined
    const altDid = typeof claims.did === 'string' ? claims.did : undefined
    return sub ?? altDid
  } catch {
    return undefined
  }
}
