// TanStack Start API route: /.well-known/:file
//
// We serve a handful of discovery documents from here:
//
//   - /.well-known/did.json — the PDS's own DID document (chapter 17).
//   - /.well-known/oauth-authorization-server — RFC 8414 metadata for our
//     OAuth role as an authorization server (chapter 21).
//   - /.well-known/oauth-protected-resource — RFC 9728 metadata for our
//     OAuth role as a protected resource (chapter 21).
//   - /.well-known/atproto-did — handle → DID lookup for atproto handle
//     verification. Keyed off the request's Host header: a fetch to
//     https://luna.wickwork.cafe/.well-known/atproto-did returns the DID
//     whose handle is `luna.wickwork.cafe`. Without this, AppViews show
//     `handle.invalid` because they can't bidirectionally verify the
//     handle claim in the user's DID document. (chapter 12 — accounts +
//     handle resolution)
//
// A catch-all keeps the file-routing tractable: a literal-dot route like
// `did[.]json.ts` exists in newer TanStack Router, but a single $file
// parameter we dispatch on internally is the simplest shape that survives
// framework version churn.

import { eq } from 'drizzle-orm'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'
import {
  authServerMetadata,
  protectedResourceMetadata,
} from '~/pds/oauth/metadata'

export const Route = createFileRoute('/.well-known/$file')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (params.file === 'did.json') {
          const cfg = getConfig()
          const doc = {
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: cfg.serviceDid,
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: cfg.publicUrl,
              },
            ],
          }
          return jsonResponse(doc)
        }
        if (params.file === 'oauth-authorization-server') {
          return jsonResponse(authServerMetadata())
        }
        if (params.file === 'oauth-protected-resource') {
          return jsonResponse(protectedResourceMetadata())
        }
        if (params.file === 'atproto-did') {
          return atprotoDidForHost(request)
        }
        return new Response('not found', { status: 404 })
      },
    },
  },
})

/** GET https://<handle>/.well-known/atproto-did
 *
 *  The host header is the handle. We look it up in the accounts table; on
 *  a match return the DID as plain text. Treat the apex host (e.g.
 *  `wickwork.cafe` itself) as not-a-handle — that one is the PDS, not a
 *  user. Per the atproto handle-resolution spec, the body is the bare DID
 *  with no trailing newline or other content. */
async function atprotoDidForHost(request: Request): Promise<Response> {
  const cfg = getConfig()
  const host = (request.headers.get('host') ?? '').toLowerCase().split(':')[0]
  if (!host) return notFound()

  // The PDS's own hostname isn't a user handle — refuse it explicitly
  // so an AppView poking around doesn't get a confusing 200 with the
  // service DID.
  if (host === cfg.hostname) return notFound()

  const row = (
    await db
      .select({ did: accounts.did, status: accounts.status })
      .from(accounts)
      .where(eq(accounts.handle, host))
      .limit(1)
  )[0]

  if (!row) return notFound()
  // takendown/deleted accounts shouldn't expose handle->DID mappings.
  // Deactivated is debatable; we allow it because federation tooling
  // expects identity lookups to still resolve.
  if (row.status === 'takendown' || row.status === 'deleted') {
    return notFound()
  }
  return new Response(row.did, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function notFound(): Response {
  return new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
