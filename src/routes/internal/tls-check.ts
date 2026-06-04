// GET /internal/tls-check?domain=<hostname>
//
// Caddy's `on_demand_tls { ask <url> }` hits this before issuing a
// Let's Encrypt cert for a hostname it doesn't already have one for.
// We answer 200 if the hostname maps to a real (non-deleted) account on
// this PDS; anything else gets 404 so Caddy refuses the cert.
//
// Without this gate, an attacker could trick Caddy into requesting
// certs for arbitrary hostnames (e.g. `attacker-controlled.example.com`)
// by sending TLS ClientHellos with that SNI value — every miss burns
// Let's Encrypt rate budget and stamps an entry in the public CT log
// claiming this PDS issued for that hostname. The ask gate stops it
// before LE is contacted.
//
// Auth: none required because the request comes from Caddy over the
// loopback and the only information returned is "does this PDS host
// the account named X?" — the same thing `resolveHandle` already
// exposes publicly. Bind Caddy's ask URL to 127.0.0.1 anyway as a
// belt-and-braces measure.
//
// See chapter 18 — Production observability (TLS for handle subdomains).

import { createFileRoute } from '@tanstack/react-router'
import { eq, ne } from 'drizzle-orm'
import { and } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { getConfig } from '~/lib/config'

export const Route = createFileRoute('/internal/tls-check')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const domain = url.searchParams.get('domain')?.toLowerCase().trim()
        if (!domain) {
          return new Response('domain query parameter required', { status: 400 })
        }

        // Always allow the PDS's own hostname — Caddy needs a cert for
        // that one too. Without this branch, the first request after
        // the Caddyfile flips to on-demand would fail because the apex
        // host isn't an account.
        if (domain === getConfig().hostname) {
          return new Response('ok (pds apex)', { status: 200 })
        }

        const rows = await db
          .select({ did: accounts.did })
          .from(accounts)
          .where(
            and(eq(accounts.handle, domain), ne(accounts.status, 'deleted')),
          )
          .limit(1)
        if (rows.length === 0) {
          return new Response(
            `no account with handle: ${domain}`,
            { status: 404 },
          )
        }
        return new Response('ok', { status: 200 })
      },
    },
  },
})
