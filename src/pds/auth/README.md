# `auth/` — Sessions, tokens, app passwords

The PDS issues short-lived **access JWTs** and longer-lived **refresh JWTs**
for client sessions. Account-protected XRPC endpoints expect the access token
in the `Authorization: Bearer ...` header.

This module:

- `jwt.ts` — sign/verify with our HS256 secret (using `jose`).
- `session.ts` — create / refresh / revoke sessions, persisted in Postgres.
- `app_password.ts` — alternate credentials for headless clients; can be
  scoped or revoked independently.
- `middleware.ts` — XRPC middleware that loads the requester's account into
  the request context.

See **[Chapter 13 — Authentication](../../../docs/13-authentication.md)**.
