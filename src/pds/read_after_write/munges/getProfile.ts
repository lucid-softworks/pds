// Read-after-write munge for `app.bsky.actor.getProfile`.
//
// When the response is for the requester's own DID, overlay any
// freshly-written `app.bsky.actor.profile` record fields. Other
// users' profiles pass through — we have no local source of truth
// for them.

import type { MungeArgs } from '../index'
import { mergeProfileRecord } from './_shared'

export type ProfileResponse = {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  banner?: string
  [k: string]: unknown
}

export async function getProfileMunge(
  args: MungeArgs<ProfileResponse>,
): Promise<ProfileResponse> {
  const { original, local, requester } = args
  if (!local.profile) return original
  if (original.did !== requester) return original
  return mergeProfileRecord(
    original,
    local.profile.record as Parameters<typeof mergeProfileRecord>[1],
  )
}
