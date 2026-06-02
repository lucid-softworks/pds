// Handle validation.
//
// Per the AT Protocol handle spec, a handle is a valid DNS hostname with a
// few extra constraints (length, allowed characters, no reserved TLDs).
// Resolution itself (handle → DID) is a separate concern; see resolver.ts.

const RESERVED_TLDS = new Set([
  'local',
  'arpa',
  'invalid',
  'localhost',
  'internal',
  'example',
  'alt',
  'onion',
])

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function isValidHandleSyntax(handle: string): boolean {
  if (handle.length < 3 || handle.length > 253) return false
  if (handle !== handle.toLowerCase()) return false
  if (handle.startsWith('.') || handle.endsWith('.')) return false
  const labels = handle.split('.')
  if (labels.length < 2) return false
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return false
  }
  const tld = labels[labels.length - 1]!
  if (/^\d+$/.test(tld)) return false // numeric-only TLD not allowed
  return true
}

export class InvalidHandleError extends Error {
  constructor(handle: string, reason: string) {
    super(`invalid handle "${handle}": ${reason}`)
    this.name = 'InvalidHandleError'
  }
}

export function assertValidHandle(handle: string): void {
  if (!isValidHandleSyntax(handle)) {
    throw new InvalidHandleError(handle, 'malformed')
  }
}

/** True iff the handle's last label is one of the reserved TLDs above. We
 *  *allow* these in dev (so `alice.test` works) but warn at the boundary. */
export function isReservedTld(handle: string): boolean {
  const tld = handle.split('.').pop() ?? ''
  return RESERVED_TLDS.has(tld)
}
