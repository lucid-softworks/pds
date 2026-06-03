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

import { XrpcError, InternalError, BadRequest, NotFound } from './errors'
import { validateInbound, validateOutbound } from './lexicon-bridge'

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
  const def = registry.get(nsid)
  if (!def) {
    return jsonResponse(
      NotFound(`unknown XRPC method: ${nsid}`, 'MethodNotImplemented'),
    )
  }
  if (request.method !== def.method) {
    return jsonResponse(
      BadRequest(
        `expected ${def.method} for ${nsid}, got ${request.method}`,
        'InvalidRequest',
      ),
    )
  }
  const url = new URL(request.url)
  const params = Object.fromEntries(url.searchParams.entries())

  try {
    const input = await readJsonBody(request)

    // Validate against the lexicon (observe-only unless LEXICON_STRICT=true).
    await validateInbound(nsid, { input, params })

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
    if (output instanceof Response) return output

    await validateOutbound(nsid, output)

    return new Response(
      output === undefined ? '' : JSON.stringify(output),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  } catch (err) {
    if (err instanceof XrpcError) return jsonResponse(err)
    console.error(`[xrpc:${nsid}]`, err)
    return jsonResponse(InternalError())
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
