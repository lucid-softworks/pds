# Running in production

> 🚧 Lands after the implementation is functionally complete.

What it takes to actually self-host this. The protocol part is portable;
the *operations* part is where you make production-vs-development choices
deliberately.

## Outline

1. **Postgres.** Pick one (Neon, Supabase, Crunchy, RDS, self-managed).
   Sizing notes. Connection pooler (PgBouncer / Neon's own pooler).
2. **TLS.** Mandatory. Cloud load balancer or fronted by Caddy/nginx.
3. **DID resolution caching.** We cache aggressively; explain TTLs and
   invalidation.
4. **Blob storage.** S3-compatible bucket. Lifecycle policy for GC'd
   blobs.
5. **The firehose connection budget.** Each consumer is a long-running
   WebSocket. Plan for hundreds.
6. **Backups.** Postgres dumps + an `s3 sync` of the blob bucket are
   enough; the MST is reconstructible from `repo_blocks` rows.
7. **Migrations.** `pnpm db:migrate` against the prod URL, run from CI on
   deploy.
8. **Observability.** What to log, what to expose as metrics, what to
   alert on.
9. **The PLC directory.** Either use the public one or run your own
   mirror. Trade-offs of each.
10. **Email.** Verification flows, recovery flows. We punt to a transactional
    provider; spec links.

← [17 — PDS vs AppView vs Relay](./17-pds-appview-relay.md) · [Table of contents](./README.md)
