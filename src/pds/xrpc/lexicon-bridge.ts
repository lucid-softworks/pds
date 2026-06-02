// Bridge between the XRPC dispatcher and the bundled lexicon validator.
//
// On each incoming request we look up the lexicon for the NSID and (when one
// exists) validate the input and output against its schemas. Mismatches are
// LOGGED, not raised — handlers still rely on their hand-rolled zod schemas
// today. This is the "validate-and-observe" rollout: once the log goes
// quiet, we can flip `LEXICON_STRICT` and let the validator reject the
// request.
//
// See chapter 9 — Lexicons. Once we throw on mismatch, the per-handler zod
// schemas come out and the lexicon owns the contract.

import {
  compileSchema,
  loadBundledLexicons,
  ValidationError,
  type LexiconCatalog,
  type LexProcedure,
  type LexQuery,
  type Validator,
} from '~/pds/lexicon'

let cachedCatalog: Promise<LexiconCatalog> | null = null

function getCatalog(): Promise<LexiconCatalog> {
  if (!cachedCatalog) cachedCatalog = loadBundledLexicons()
  return cachedCatalog
}

type CompiledMethod = {
  /** True iff `main` is a procedure or query. False for records/tokens. */
  hasMethod: boolean
  /** Validator for `input.schema` (procedures with JSON body), if present. */
  inputBody: Validator | null
  /** Validator for `parameters` (query string), if present. */
  parameters: Validator | null
  /** Validator for `output.schema` (JSON responses), if present. */
  output: Validator | null
  /** main.input.encoding, used to skip body validation for binary uploads. */
  inputEncoding: string | undefined
}

const methodCache = new Map<string, CompiledMethod | null>()

async function compileMethod(nsid: string): Promise<CompiledMethod | null> {
  if (methodCache.has(nsid)) return methodCache.get(nsid) ?? null
  const catalog = await getCatalog()
  const doc = catalog.get(nsid)
  if (!doc) {
    methodCache.set(nsid, null)
    return null
  }
  const main = doc.defs.main
  if (!main || (main.type !== 'procedure' && main.type !== 'query')) {
    methodCache.set(nsid, null)
    return null
  }
  const method = main as LexProcedure | LexQuery
  const compiled: CompiledMethod = {
    hasMethod: true,
    inputBody: null,
    parameters: null,
    output: null,
    inputEncoding: undefined,
  }
  if (method.type === 'procedure') {
    compiled.inputEncoding = method.input?.encoding
    if (method.input?.schema) {
      compiled.inputBody = compileSchema(method.input.schema, catalog, nsid)
    }
  }
  if (method.parameters) {
    compiled.parameters = compileSchema(method.parameters, catalog, nsid)
  }
  if (method.output?.schema && method.output.encoding === 'application/json') {
    compiled.output = compileSchema(method.output.schema, catalog, nsid)
  }
  methodCache.set(nsid, compiled)
  return compiled
}

function isStrict(): boolean {
  return process.env.LEXICON_STRICT === 'true'
}

/** Validate input + parameters before the handler runs. Throws on mismatch
 *  only in strict mode; otherwise logs. */
export async function validateInbound(
  nsid: string,
  args: { input: unknown; params: Record<string, string> },
): Promise<void> {
  const compiled = await compileMethod(nsid)
  if (!compiled) return

  // Body validation (procedures with JSON input only)
  if (
    compiled.inputBody &&
    compiled.inputEncoding &&
    compiled.inputEncoding.startsWith('application/json')
  ) {
    try {
      compiled.inputBody(args.input)
    } catch (err) {
      handle(nsid, 'input', err)
    }
  }

  // Parameter validation (query string)
  if (compiled.parameters && Object.keys(args.params).length > 0) {
    try {
      compiled.parameters(coerceParamTypes(args.params))
    } catch (err) {
      handle(nsid, 'params', err)
    }
  }
}

/** Validate the handler's output before serializing it. Soft-fail unless
 *  strict mode is enabled. Always silently passes for Response objects
 *  (binary responses) — those don't have a JSON schema. */
export async function validateOutbound(
  nsid: string,
  output: unknown,
): Promise<void> {
  if (output instanceof Response) return
  const compiled = await compileMethod(nsid)
  if (!compiled || !compiled.output) return
  try {
    compiled.output(output)
  } catch (err) {
    handle(nsid, 'output', err)
  }
}

function handle(nsid: string, side: 'input' | 'output' | 'params', err: unknown): void {
  const message =
    err instanceof ValidationError
      ? `${err.path || '<root>'}: ${err.reason}`
      : (err as Error).message
  if (isStrict()) {
    if (err instanceof ValidationError) throw err
    throw err
  }
  console.warn(`[lexicon:${side}] ${nsid}: ${message}`)
}

// Query strings arrive as flat string maps; lexicon params declare typed
// shapes (booleans, integers, arrays). This is a best-effort coercion so the
// validator sees the right *kind* of value; the real swap-zod-for-lexicon
// migration will replace it with proper type-aware decoding.
function coerceParamTypes(
  params: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === 'true') out[k] = true
    else if (v === 'false') out[k] = false
    else if (/^-?\d+$/.test(v)) out[k] = Number(v)
    else out[k] = v
  }
  return out
}
