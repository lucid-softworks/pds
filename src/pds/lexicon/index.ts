// Barrel for the lexicon module.

export type {
  LexiconDoc,
  LexUserType,
  LexSchema,
  LexPrimitive,
  LexStringFormat,
  LexString,
  LexInteger,
  LexBoolean,
  LexNull,
  LexUnknown,
  LexBytes,
  LexCidLink,
  LexBlob,
  LexArray,
  LexObject,
  LexRef,
  LexUnion,
  LexToken,
  LexParams,
  LexBody,
  LexQuery,
  LexProcedure,
  LexSubscription,
  LexRecord,
  LexXrpcError,
} from './types'

export { isMethod, isRecord } from './types'

export {
  loadBundledLexicons,
  makeCatalog,
} from './loader'
export type { LexiconCatalog } from './loader'

export {
  ValidationError,
  compileSchema,
  validateAgainstNsid,
} from './validate'
export type { Validator } from './validate'
