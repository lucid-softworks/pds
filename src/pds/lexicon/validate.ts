// Runtime lexicon validator.
//
// `compileSchema(schema, catalog, contextNsid)` returns a `(value) => value`
// function. Compilation walks the schema once, resolving refs and capturing
// closures; the returned validator is the hot path. Validators throw
// `ValidationError` on failure and return the (lightly normalized) value on
// success.
//
// "Lightly normalized" = `cid-link` values are passed through unchanged; we
// don't decode them into CID objects at this layer because the wire format
// (CBOR vs JSON) decides what they look like. Object validators do *not* strip
// unknown keys — the AT Protocol convention is "lenient on read, strict on
// write," and that decision belongs to the caller, not the schema.
//
// The validator currently runs in strict mode (unknown keys rejected). When we
// wire it into the dispatcher we'll add a `lenient` flag for outgoing /
// firehose-incoming payloads.

import { CID } from 'multiformats/cid'

import { isValidHandleSyntax } from '~/pds/did/handle'
import { isValidTid } from '~/pds/repo/tid'
import { XrpcError } from '~/pds/xrpc/errors'

import type {
  LexArray,
  LexBlob,
  LexBoolean,
  LexBytes,
  LexCidLink,
  LexInteger,
  LexNull,
  LexObject,
  LexParams,
  LexPrimitive,
  LexRef,
  LexSchema,
  LexString,
  LexUnion,
  LexUnknown,
  LexUserType,
  LexiconDoc,
} from './types'
import type { LexiconCatalog } from './loader'

export class ValidationError extends XrpcError {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(400, 'InvalidRequest', `${path || '<root>'}: ${reason}`)
    this.name = 'ValidationError'
  }
}

export type Validator = (value: unknown) => unknown

/** Compile a schema into a validator. Walks the schema once, caches resolved
 *  refs to avoid infinite recursion on cyclic types. */
export function compileSchema(
  schema: LexSchema | LexParams,
  catalog: LexiconCatalog,
  contextNsid: string,
): Validator {
  const ctx: CompileCtx = { catalog, contextNsid, refCache: new Map() }
  return compile(schema, ctx)
}

/** Validate a value against a named lexicon's `main` def. For records the
 *  schema is the inner `record` object; for procedures/queries this isn't the
 *  right entrypoint — use `compileSchema` against `input.schema` instead. */
export function validateAgainstNsid(
  catalog: LexiconCatalog,
  nsid: string,
  value: unknown,
): unknown {
  const doc = catalog.get(nsid)
  if (!doc) throw new ValidationError('', `unknown lexicon: ${nsid}`)
  const main = doc.defs.main
  if (!main) throw new ValidationError('', `lexicon ${nsid} has no main def`)
  const schema = mainAsSchema(main, nsid)
  return compileSchema(schema, catalog, nsid)(value)
}

function mainAsSchema(def: LexUserType, nsid: string): LexSchema {
  switch (def.type) {
    case 'record':
      return def.record
    case 'object':
    case 'string':
    case 'integer':
    case 'boolean':
    case 'null':
    case 'bytes':
    case 'cid-link':
    case 'blob':
    case 'array':
    case 'ref':
    case 'union':
    case 'unknown':
      return def
    default:
      throw new ValidationError(
        '',
        `lexicon ${nsid} main def is ${def.type}; use compileSchema directly`,
      )
  }
}

// ---------------------------------------------------------------------------

type CompileCtx = {
  catalog: LexiconCatalog
  contextNsid: string
  // Cache of refs being compiled. Key is `${nsid}#${defname}` (post-resolve).
  // Stores a function box so recursive refs can close over the eventual
  // validator without a stack overflow.
  refCache: Map<string, { fn: Validator | null }>
}

function compile(schema: LexSchema | LexParams, ctx: CompileCtx): Validator {
  switch (schema.type) {
    case 'string':
      return compileString(schema)
    case 'integer':
      return compileInteger(schema)
    case 'boolean':
      return compileBoolean(schema)
    case 'null':
      return compileNull(schema)
    case 'unknown':
      return compileUnknown(schema)
    case 'bytes':
      return compileBytes(schema)
    case 'cid-link':
      return compileCidLink(schema)
    case 'blob':
      return compileBlob(schema)
    case 'array':
      return compileArray(schema, ctx)
    case 'object':
      return compileObject(schema, ctx)
    case 'params':
      return compileParams(schema, ctx)
    case 'ref':
      return compileRef(schema, ctx)
    case 'union':
      return compileUnion(schema, ctx)
  }
}

// ---- Strings ---------------------------------------------------------------

// Intl.Segmenter is the right Unicode-aware grapheme counter. It's available
// in Node 16+ and modern browsers; the fallback (spread → code points) is
// wrong for ZWJ sequences and complex emoji but acceptable for the teaching
// project on the rare runtime that lacks it.
const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null

function graphemeCount(s: string): number {
  if (SEGMENTER) {
    let n = 0
    for (const _ of SEGMENTER.segment(s)) n++
    return n
  }
  return [...s].length
}

const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]+[A-Za-z0-9._-]$/
const NSID_RE =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.[A-Za-z][A-Za-z0-9]*$/
const RECORD_KEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/
const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/
// at-uri: at://<authority>(/<collection>(/<rkey>(/<fragment>)?)?)?
const AT_URI_RE =
  /^at:\/\/(?:did:[a-z]+:[A-Za-z0-9._:%-]+|[a-z0-9][a-z0-9.-]*)(?:\/[^\s]*)?$/

function compileString(schema: LexString): Validator {
  const {
    minLength,
    maxLength,
    minGraphemes,
    maxGraphemes,
    format,
    enum: enumVals,
    const: constVal,
  } = schema
  return (value: unknown) => {
    if (typeof value !== 'string') {
      throw new ValidationError('', `expected string, got ${typeOf(value)}`)
    }
    if (constVal !== undefined && value !== constVal) {
      throw new ValidationError('', `expected const "${constVal}"`)
    }
    if (enumVals && !enumVals.includes(value)) {
      throw new ValidationError('', `not in enum: ${value}`)
    }
    // maxLength is in UTF-8 bytes per the spec; we approximate with byte length.
    if (minLength !== undefined && byteLength(value) < minLength) {
      throw new ValidationError('', `shorter than minLength ${minLength}`)
    }
    if (maxLength !== undefined && byteLength(value) > maxLength) {
      throw new ValidationError('', `longer than maxLength ${maxLength}`)
    }
    if (minGraphemes !== undefined || maxGraphemes !== undefined) {
      const n = graphemeCount(value)
      if (minGraphemes !== undefined && n < minGraphemes) {
        throw new ValidationError(
          '',
          `fewer than minGraphemes ${minGraphemes} (got ${n})`,
        )
      }
      if (maxGraphemes !== undefined && n > maxGraphemes) {
        throw new ValidationError(
          '',
          `more than maxGraphemes ${maxGraphemes} (got ${n})`,
        )
      }
    }
    if (format) checkStringFormat(value, format)
    return value
  }
}

function byteLength(s: string): number {
  // TextEncoder counts UTF-8 bytes, which is what maxLength means per spec.
  return new TextEncoder().encode(s).length
}

function checkStringFormat(value: string, format: LexString['format']): void {
  switch (format) {
    case 'datetime':
      if (!DATETIME_RE.test(value)) {
        throw new ValidationError('', 'expected ISO 8601 datetime with TZ')
      }
      // Cross-check that the calendar fields are real (e.g. Feb 30 fails).
      if (Number.isNaN(Date.parse(value))) {
        throw new ValidationError('', 'datetime is syntactically valid but not a real date')
      }
      return
    case 'uri':
    case 'uri-reference':
      try {
        // URL needs a base for reference-form URIs; absolute URIs work without.
        new URL(value)
      } catch {
        throw new ValidationError('', 'invalid uri')
      }
      return
    case 'uri-template':
      // Loose: just require it parses with placeholders elided.
      try {
        new URL(value.replace(/\{[^}]+\}/g, 'x'))
      } catch {
        throw new ValidationError('', 'invalid uri-template')
      }
      return
    case 'at-uri':
      if (!AT_URI_RE.test(value)) {
        throw new ValidationError('', 'invalid at-uri')
      }
      return
    case 'did':
      if (!DID_RE.test(value)) throw new ValidationError('', 'invalid did')
      return
    case 'handle':
      if (!isValidHandleSyntax(value)) {
        throw new ValidationError('', 'invalid handle')
      }
      return
    case 'at-identifier':
      if (!DID_RE.test(value) && !isValidHandleSyntax(value)) {
        throw new ValidationError('', 'invalid at-identifier (handle or did)')
      }
      return
    case 'nsid':
      if (!NSID_RE.test(value)) throw new ValidationError('', 'invalid nsid')
      return
    case 'cid':
      try {
        CID.parse(value)
      } catch {
        throw new ValidationError('', 'invalid cid')
      }
      return
    case 'language':
      if (!LANGUAGE_RE.test(value)) {
        throw new ValidationError('', 'invalid language tag')
      }
      return
    case 'tid':
      if (!isValidTid(value)) throw new ValidationError('', 'invalid tid')
      return
    case 'record-key':
      if (!RECORD_KEY_RE.test(value) || value === '.' || value === '..') {
        throw new ValidationError('', 'invalid record-key')
      }
      return
    default:
      return
  }
}

// ---- Numbers + scalars -----------------------------------------------------

function compileInteger(schema: LexInteger): Validator {
  const { minimum, maximum, enum: enumVals, const: constVal } = schema
  return (value: unknown) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ValidationError('', `expected integer, got ${typeOf(value)}`)
    }
    if (constVal !== undefined && value !== constVal) {
      throw new ValidationError('', `expected const ${constVal}`)
    }
    if (enumVals && !enumVals.includes(value)) {
      throw new ValidationError('', `not in enum: ${value}`)
    }
    if (minimum !== undefined && value < minimum) {
      throw new ValidationError('', `below minimum ${minimum}`)
    }
    if (maximum !== undefined && value > maximum) {
      throw new ValidationError('', `above maximum ${maximum}`)
    }
    return value
  }
}

function compileBoolean(schema: LexBoolean): Validator {
  const { const: constVal } = schema
  return (value: unknown) => {
    if (typeof value !== 'boolean') {
      throw new ValidationError('', `expected boolean, got ${typeOf(value)}`)
    }
    if (constVal !== undefined && value !== constVal) {
      throw new ValidationError('', `expected const ${constVal}`)
    }
    return value
  }
}

function compileNull(_schema: LexNull): Validator {
  return (value: unknown) => {
    if (value !== null) {
      throw new ValidationError('', `expected null, got ${typeOf(value)}`)
    }
    return value
  }
}

function compileUnknown(_schema: LexUnknown): Validator {
  // `unknown` means "must be present and non-null" — the AT Protocol intent is
  // an escape hatch, not an optional slot.
  return (value: unknown) => {
    if (value === undefined || value === null) {
      throw new ValidationError('', 'expected unknown (any non-null value)')
    }
    return value
  }
}

function compileBytes(schema: LexBytes): Validator {
  const { minLength, maxLength } = schema
  return (value: unknown) => {
    if (!(value instanceof Uint8Array)) {
      throw new ValidationError('', `expected bytes, got ${typeOf(value)}`)
    }
    if (minLength !== undefined && value.byteLength < minLength) {
      throw new ValidationError('', `bytes shorter than minLength ${minLength}`)
    }
    if (maxLength !== undefined && value.byteLength > maxLength) {
      throw new ValidationError('', `bytes longer than maxLength ${maxLength}`)
    }
    return value
  }
}

// ---- cid-link, blob --------------------------------------------------------

function compileCidLink(_schema: LexCidLink): Validator {
  return (value: unknown) => {
    // Accept either:
    //   - a CID object (CBOR path; @ipld/dag-cbor decodes to CID instances)
    //   - `{ $link: <multibase string> }` (JSON path)
    if (value && typeof value === 'object') {
      if (value instanceof CID) return value
      const link = (value as Record<string, unknown>).$link
      if (typeof link === 'string') {
        try {
          CID.parse(link)
        } catch {
          throw new ValidationError('', 'invalid cid-link: $link not a valid CID')
        }
        return value
      }
    }
    throw new ValidationError(
      '',
      'expected cid-link ({ $link } or CID instance)',
    )
  }
}

function compileBlob(schema: LexBlob): Validator {
  const { accept, maxSize } = schema
  return (value: unknown) => {
    if (!value || typeof value !== 'object') {
      throw new ValidationError('', `expected blob object, got ${typeOf(value)}`)
    }
    const obj = value as Record<string, unknown>
    if (obj.$type !== 'blob') {
      throw new ValidationError('', 'blob missing $type: "blob"')
    }
    const ref = obj.ref
    if (!ref || (typeof ref !== 'object' && !(ref instanceof CID))) {
      throw new ValidationError('', 'blob.ref must be a cid-link')
    }
    if (!(ref instanceof CID)) {
      const link = (ref as Record<string, unknown>).$link
      if (typeof link !== 'string') {
        throw new ValidationError('', 'blob.ref.$link must be a string')
      }
      try {
        CID.parse(link)
      } catch {
        throw new ValidationError('', 'blob.ref.$link is not a valid CID')
      }
    }
    if (typeof obj.mimeType !== 'string') {
      throw new ValidationError('', 'blob.mimeType must be a string')
    }
    if (typeof obj.size !== 'number' || !Number.isInteger(obj.size) || obj.size < 0) {
      throw new ValidationError('', 'blob.size must be a non-negative integer')
    }
    if (accept && accept.length && !mimeAccepted(obj.mimeType, accept)) {
      throw new ValidationError(
        '',
        `blob mimeType ${obj.mimeType} not in accept list`,
      )
    }
    if (maxSize !== undefined && obj.size > maxSize) {
      throw new ValidationError('', `blob exceeds maxSize ${maxSize}`)
    }
    return value
  }
}

function mimeAccepted(mime: string, accept: string[]): boolean {
  for (const pat of accept) {
    if (pat === '*/*' || pat === mime) return true
    if (pat.endsWith('/*')) {
      const prefix = pat.slice(0, -1) // 'image/'
      if (mime.startsWith(prefix)) return true
    }
  }
  return false
}

// ---- Container schemas -----------------------------------------------------

function compileArray(schema: LexArray, ctx: CompileCtx): Validator {
  const items = compile(schema.items, ctx)
  const { minLength, maxLength } = schema
  return (value: unknown) => {
    if (!Array.isArray(value)) {
      throw new ValidationError('', `expected array, got ${typeOf(value)}`)
    }
    if (minLength !== undefined && value.length < minLength) {
      throw new ValidationError('', `array shorter than minLength ${minLength}`)
    }
    if (maxLength !== undefined && value.length > maxLength) {
      throw new ValidationError('', `array longer than maxLength ${maxLength}`)
    }
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      try {
        out.push(items(value[i]))
      } catch (err) {
        rethrowAt(err, `[${i}]`)
      }
    }
    return out
  }
}

function compileObject(schema: LexObject, ctx: CompileCtx): Validator {
  const propValidators = new Map<string, Validator>()
  for (const [name, prop] of Object.entries(schema.properties)) {
    propValidators.set(name, compile(prop, ctx))
  }
  const required = new Set(schema.required ?? [])
  const nullable = new Set(schema.nullable ?? [])
  const knownKeys = new Set(Object.keys(schema.properties))

  return (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError('', `expected object, got ${typeOf(value)}`)
    }
    const input = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of required) {
      if (!(key in input)) {
        throw new ValidationError('', `missing required property "${key}"`)
      }
    }
    for (const [key, raw] of Object.entries(input)) {
      // `$type` is a structural tag (union discriminator, blob tag, record
      // type). Always allow it through.
      if (key === '$type') {
        out[key] = raw
        continue
      }
      if (!knownKeys.has(key)) {
        throw new ValidationError('', `unknown property "${key}"`)
      }
      if (raw === undefined) continue
      if (raw === null) {
        if (nullable.has(key) || !required.has(key)) {
          out[key] = null
          continue
        }
        throw new ValidationError(key, 'null not allowed')
      }
      const validator = propValidators.get(key)!
      try {
        out[key] = validator(raw)
      } catch (err) {
        rethrowAt(err, key)
      }
    }
    return out
  }
}

function compileParams(schema: LexParams, ctx: CompileCtx): Validator {
  // `params` looks like an object but its property types are restricted to
  // primitives + arrays of primitives. We delegate to the object compiler with
  // those constraints already encoded in the schema we were handed.
  return compileObject(
    {
      type: 'object',
      required: schema.required,
      properties: schema.properties as Record<string, LexSchema>,
    },
    ctx,
  )
}

// ---- Refs + unions ---------------------------------------------------------

function compileRef(schema: LexRef, ctx: CompileCtx): Validator {
  const target = ctx.catalog.resolve(schema.ref, ctx.contextNsid)
  if (!target) {
    throw new Error(
      `lexicon ref ${schema.ref} (from ${ctx.contextNsid}) not in catalog`,
    )
  }
  // Refs *can* be cyclic (a record's replyRef → strongRef → ...). We cache by
  // canonical key so a second visit returns a thunk that defers to the
  // eventually-populated box.
  const canonical = canonicalRef(schema.ref, ctx.contextNsid)
  const cached = ctx.refCache.get(canonical)
  if (cached) {
    return (value: unknown) => {
      const fn = cached.fn
      if (!fn) throw new Error(`ref ${canonical} called before compiled`)
      return fn(value)
    }
  }
  const box: { fn: Validator | null } = { fn: null }
  ctx.refCache.set(canonical, box)
  const inner = compileResolved(target, schema.ref, ctx)
  box.fn = inner
  return inner
}

function canonicalRef(ref: string, contextNsid: string): string {
  if (ref.startsWith('#')) return `${contextNsid}${ref}`
  if (!ref.includes('#')) return `${ref}#main`
  return ref
}

function compileResolved(
  target: LexUserType,
  refStr: string,
  ctx: CompileCtx,
): Validator {
  // Refs can land on the schema variants used inside object properties, plus
  // `record` (whose inner schema is `.record`). Other top-level shapes (query,
  // procedure, subscription, params, token) aren't valid as ref targets.
  switch (target.type) {
    case 'object':
    case 'string':
    case 'integer':
    case 'boolean':
    case 'null':
    case 'bytes':
    case 'cid-link':
    case 'blob':
    case 'array':
    case 'union':
    case 'unknown':
    case 'ref':
      return compile(target, refTargetCtx(refStr, ctx))
    case 'record':
      return compile(target.record, refTargetCtx(refStr, ctx))
    default:
      throw new Error(
        `lexicon ref ${refStr} resolves to ${target.type}, not allowed as ref target`,
      )
  }
}

function refTargetCtx(refStr: string, ctx: CompileCtx): CompileCtx {
  // When following a ref into another NSID, the context for *its* internal
  // refs needs to be that target NSID, not the originating one.
  let targetNsid = ctx.contextNsid
  if (!refStr.startsWith('#')) {
    targetNsid = refStr.includes('#') ? refStr.split('#')[0]! : refStr
  }
  return { ...ctx, contextNsid: targetNsid }
}

function compileUnion(schema: LexUnion, ctx: CompileCtx): Validator {
  // Pre-compile every variant under its $type tag. Variants are refs, so we
  // resolve them through the catalog at compile time.
  const variants = new Map<string, Validator>()
  for (const ref of schema.refs) {
    const target = ctx.catalog.resolve(ref, ctx.contextNsid)
    if (!target) {
      // It's legal for a union to reference an NSID we haven't bundled. We
      // skip it at compile time; if an instance arrives with that $type the
      // validator falls through to the "unknown variant" branch.
      continue
    }
    const tag = absoluteRef(ref, ctx.contextNsid)
    variants.set(tag, compileResolved(target, ref, ctx))
  }
  const closed = !!schema.closed

  return (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError('', `expected object for union, got ${typeOf(value)}`)
    }
    const tag = (value as Record<string, unknown>).$type
    if (typeof tag !== 'string') {
      throw new ValidationError('', 'union variant missing $type')
    }
    const validator = variants.get(tag)
    if (!validator) {
      if (closed) {
        throw new ValidationError('', `unknown union variant $type=${tag}`)
      }
      // Open unions allow unknown variants through unchanged — this is the
      // forward-compat hatch the chapter calls out.
      return value
    }
    return validator(value)
  }
}

function absoluteRef(ref: string, contextNsid: string): string {
  if (ref.startsWith('#')) return `${contextNsid}${ref}`
  if (!ref.includes('#')) return ref
  // A union $type is `nsid` (no fragment) when the variant is the main def.
  const [nsid, defName] = ref.split('#') as [string, string]
  return defName === 'main' ? nsid : ref
}

// ---- Helpers ---------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Uint8Array) return 'bytes'
  return typeof value
}

function rethrowAt(err: unknown, segment: string): never {
  if (err instanceof ValidationError) {
    const path = err.path ? `${segment}.${err.path}` : segment
    throw new ValidationError(path.replace(/^\./, ''), err.reason)
  }
  throw err
}

// Re-export for callers that only want the catalog type from this module.
export type { LexiconCatalog, LexiconDoc }
