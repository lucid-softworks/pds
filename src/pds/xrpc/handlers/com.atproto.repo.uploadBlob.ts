// XRPC handler: com.atproto.repo.uploadBlob
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/uploadBlob.json
//
// The client POSTs raw bytes with whatever Content-Type the file actually has
// (image/jpeg, video/mp4, …). We hash the bytes, persist them via the blob
// store, insert the metadata row, and return a blob ref the client will later
// embed in a record. The blob is unattached at this point — see chapter 15
// for the GC story.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { XrpcError } from '../errors'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { uploadBlob } from '~/pds/blob/upload'

const MAX_BLOB_BYTES = 5 * 1024 * 1024 // 5 MB

const handler: Handler = async ({ authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  const mimeType =
    request.headers.get('content-type') ?? 'application/octet-stream'
  const buf = await request.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes.length === 0) {
    throw BadRequest('empty blob body', 'InvalidRequest')
  }
  if (bytes.length > MAX_BLOB_BYTES) {
    throw new XrpcError(
      413,
      'BlobTooLarge',
      `blob exceeds ${MAX_BLOB_BYTES} bytes`,
    )
  }
  const ref = await uploadBlob({
    creator: me.did,
    bytes,
    mimeType,
  })
  return {
    blob: {
      $type: 'blob',
      // cid-link refs serialize in JSON as `{ $link: '<cid-string>' }`. In
      // CBOR-encoded records they go on the wire as tag 42.
      ref: { $link: ref.ref.toString() },
      mimeType: ref.mimeType,
      size: ref.size,
    },
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.repo.uploadBlob'
