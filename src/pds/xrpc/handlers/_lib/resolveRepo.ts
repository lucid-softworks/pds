// Shared helper: resolve an XRPC `repo` parameter (DID *or* handle) to a DID.
//
// The repo.* methods all accept either form. We look up handles against the
// local accounts table; cross-PDS resolution lives in a later chapter.

import { BadRequest } from '~/pds/xrpc/errors'
import { isValidHandleSyntax } from '~/pds/did/handle'
import { resolveLocalHandle } from '~/pds/did/resolver'

export async function resolveRepoIdent(repo: string): Promise<string> {
  const trimmed = repo.trim()
  if (trimmed.startsWith('did:')) return trimmed
  const handle = trimmed.toLowerCase()
  if (!isValidHandleSyntax(handle)) {
    throw BadRequest(`invalid repo identifier: ${repo}`, 'InvalidRequest')
  }
  const did = await resolveLocalHandle(handle)
  if (!did) {
    throw BadRequest(`unable to resolve repo: ${repo}`, 'RepoNotFound')
  }
  return did
}
