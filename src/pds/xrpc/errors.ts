// Canonical XRPC error envelope.
//
// Every XRPC error response is `{ error: <name>, message: <human-readable> }`
// with an HTTP status code in 4xx/5xx. The error `name` is a lexicon-defined
// machine-readable tag; the message is for humans.

export class XrpcError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorName: string,
    message: string,
  ) {
    super(message)
    this.name = 'XrpcError'
  }

  toResponseBody() {
    return { error: this.errorName, message: this.message }
  }
}

// Common errors with their canonical names from the AT Protocol spec.

export const BadRequest = (msg: string, name = 'InvalidRequest') =>
  new XrpcError(400, name, msg)

export const Unauthorized = (msg: string, name = 'AuthMissing') =>
  new XrpcError(401, name, msg)

export const Forbidden = (msg: string, name = 'Forbidden') =>
  new XrpcError(403, name, msg)

export const NotFound = (msg: string, name = 'NotFound') =>
  new XrpcError(404, name, msg)

export const Conflict = (msg: string, name = 'Conflict') =>
  new XrpcError(409, name, msg)

export const InternalError = (msg = 'unexpected error') =>
  new XrpcError(500, 'InternalServerError', msg)
