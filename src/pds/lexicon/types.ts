// Typed schema graph for AT Protocol lexicons.
//
// Each variant is tagged by `type` so the validator can switch on it. We model
// only the fields the runtime needs — UI-only hints like `description` are
// accepted by the parser but unused, so we don't bother typing them.
//
// See chapter 09 for the language sketch. The names match the upstream JSON
// (`cid-link`, `record-key`, etc.) wherever the spec uses kebab/dot forms.

export type LexiconDoc = {
  lexicon: 1
  id: string
  revision?: number
  description?: string
  defs: Record<string, LexUserType>
}

// `LexUserType` covers anything that can sit at `defs.<name>`. Schemas nested
// inside an object's properties are `LexSchema` — a subset that excludes the
// XRPC-method shapes and `token`.
export type LexUserType =
  | LexRecord
  | LexQuery
  | LexProcedure
  | LexSubscription
  | LexToken
  | LexObject
  | LexArray
  | LexString
  | LexInteger
  | LexBoolean
  | LexNull
  | LexBytes
  | LexCidLink
  | LexBlob
  | LexRef
  | LexUnion
  | LexUnknown
  | LexParams

export type LexSchema =
  | LexString
  | LexInteger
  | LexBoolean
  | LexNull
  | LexBytes
  | LexCidLink
  | LexBlob
  | LexArray
  | LexObject
  | LexRef
  | LexUnion
  | LexUnknown

export type LexPrimitive =
  | LexString
  | LexInteger
  | LexBoolean
  | LexUnknown

export type LexStringFormat =
  | 'datetime'
  | 'uri'
  | 'at-uri'
  | 'did'
  | 'handle'
  | 'at-identifier'
  | 'nsid'
  | 'cid'
  | 'language'
  | 'tid'
  | 'record-key'
  | 'uri-reference'
  | 'uri-template'

// ---- Primitives ------------------------------------------------------------

export type LexString = {
  type: 'string'
  description?: string
  format?: LexStringFormat
  minLength?: number
  maxLength?: number
  minGraphemes?: number
  maxGraphemes?: number
  knownValues?: string[]
  enum?: string[]
  default?: string
  const?: string
}

export type LexInteger = {
  type: 'integer'
  description?: string
  minimum?: number
  maximum?: number
  enum?: number[]
  default?: number
  const?: number
}

export type LexBoolean = {
  type: 'boolean'
  description?: string
  default?: boolean
  const?: boolean
}

export type LexNull = {
  type: 'null'
  description?: string
}

export type LexUnknown = {
  type: 'unknown'
  description?: string
}

export type LexBytes = {
  type: 'bytes'
  description?: string
  minLength?: number
  maxLength?: number
}

export type LexCidLink = {
  type: 'cid-link'
  description?: string
}

export type LexBlob = {
  type: 'blob'
  description?: string
  accept?: string[]
  maxSize?: number
}

// ---- Containers ------------------------------------------------------------

export type LexArray = {
  type: 'array'
  description?: string
  items: LexSchema
  minLength?: number
  maxLength?: number
}

export type LexObject = {
  type: 'object'
  description?: string
  required?: string[]
  nullable?: string[]
  properties: Record<string, LexSchema>
}

// ---- References + unions ---------------------------------------------------

export type LexRef = {
  type: 'ref'
  description?: string
  ref: string
}

export type LexUnion = {
  type: 'union'
  description?: string
  refs: string[]
  closed?: boolean
}

// ---- Tokens, params --------------------------------------------------------

export type LexToken = {
  type: 'token'
  description?: string
}

export type LexParams = {
  type: 'params'
  description?: string
  required?: string[]
  properties: Record<string, LexPrimitive | LexArray>
}

// ---- XRPC method shapes ----------------------------------------------------

export type LexBody = {
  description?: string
  encoding: string
  schema?: LexObject | LexRef | LexUnion
}

export type LexSubscriptionMessage = {
  description?: string
  schema?: LexObject | LexRef | LexUnion
}

export type LexXrpcError = {
  name: string
  description?: string
}

export type LexQuery = {
  type: 'query'
  description?: string
  parameters?: LexParams
  output?: LexBody
  errors?: LexXrpcError[]
}

export type LexProcedure = {
  type: 'procedure'
  description?: string
  parameters?: LexParams
  input?: LexBody
  output?: LexBody
  errors?: LexXrpcError[]
}

export type LexSubscription = {
  type: 'subscription'
  description?: string
  parameters?: LexParams
  message?: LexSubscriptionMessage
  errors?: LexXrpcError[]
}

export type LexRecord = {
  type: 'record'
  description?: string
  key: string
  record: LexObject
}

// Type guards used by the validator and dispatcher (later).

export function isMethod(
  def: LexUserType,
): def is LexQuery | LexProcedure | LexSubscription {
  return (
    def.type === 'query' ||
    def.type === 'procedure' ||
    def.type === 'subscription'
  )
}

export function isRecord(def: LexUserType): def is LexRecord {
  return def.type === 'record'
}
