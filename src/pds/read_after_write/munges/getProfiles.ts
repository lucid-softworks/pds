// Read-after-write munge for `app.bsky.actor.getProfiles`.
//
// Batched variant of getProfile. Walk the `profiles` array and apply
// the same overlay to whichever entry matches the requester's DID.

import type { MungeArgs } from '../index'
import { mergeProfileRecord } from './_shared'

type ProfileEntry = {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  banner?: string
  [k: string]: unknown
}

export type ProfilesResponse = {
  profiles: ProfileEntry[]
}

export async function getProfilesMunge(
  args: MungeArgs<ProfilesResponse>,
): Promise<ProfilesResponse> {
  const { original, local, requester } = args
  if (!local.profile) return original

  return {
    ...original,
    profiles: original.profiles.map((p) =>
      p.did === requester
        ? mergeProfileRecord(
            p,
            local.profile!.record as Parameters<typeof mergeProfileRecord>[1],
          )
        : p,
    ),
  }
}
