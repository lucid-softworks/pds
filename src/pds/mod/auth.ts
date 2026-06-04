// Moderation-surface auth gate.
//
// `tools.ozone.*` XRPC handlers + the `/mod` UI accept two auth modes:
//
//   1. Admin Basic — the operator with the admin password is always
//      allowed, even if their DID isn't in `mod_team`. Mirrors the
//      "admin can do anything" invariant in chapter 19.
//   2. Moderator access JWT — the bearer is a normal atproto access
//      token; the subject DID must be in `mod_team`.
//
// The returned shape tells the caller which mode authenticated, so
// per-action validation (e.g. emitEvent's `createdBy` must equal the
// caller's DID when not admin) can branch accordingly.
//
// See chapter 24 — Ozone-shaped moderation.

import { Forbidden, Unauthorized } from '~/pds/xrpc/errors'
import { requireAccessAuth, requireAdmin } from '~/pds/auth/middleware'
import { isModerator } from './team'

export type ModAuth =
  | { kind: 'admin' }
  | { kind: 'moderator'; did: string }

/** Resolve the caller's authorisation against the moderation surface.
 *  Throws an XRPC error if neither admin Basic nor a valid moderator
 *  DID-token reached the handler. */
export async function requireModerator(
  authorization: string | undefined,
): Promise<ModAuth> {
  if (!authorization) {
    throw Unauthorized(
      'admin Basic auth or moderator bearer required',
      'AuthMissing',
    )
  }
  const trimmed = authorization.trim()
  if (/^basic\s+/i.test(trimmed)) {
    await requireAdmin(authorization)
    return { kind: 'admin' }
  }
  if (/^bearer\s+/i.test(trimmed)) {
    const account = await requireAccessAuth(authorization)
    if (!(await isModerator(account.did))) {
      throw Forbidden(
        `${account.did} is not a member of the moderation team`,
        'NotAModerator',
      )
    }
    return { kind: 'moderator', did: account.did }
  }
  throw Unauthorized(
    'unsupported authorization scheme (expected Basic or Bearer)',
    'InvalidToken',
  )
}
