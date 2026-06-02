# Authentication

> 🚧 This chapter ships with the `src/pds/auth/` session.

The PDS issues short-lived access JWTs and long-lived refresh JWTs, plus
**app passwords** — alternate credentials a user can issue for headless
clients (CLI tools, bots) and revoke without resetting their main password.

## Outline

1. **The session pair.** Access JWT (~2 hours) + refresh JWT (~2 months),
   returned by `createSession` and `refreshSession`.
2. **JWT shape.** HS256, `iss` = service DID, `aud` = same, `sub` = user DID,
   `exp`, `jti`.
3. **Refresh tokens are persisted.** Why we can't make them purely
   stateless: revocation. The `refresh_tokens` table is the source of truth.
4. **Password hashing.** `scrypt` via `node:crypto`. Why we don't use
   bcrypt.
5. **App passwords.** Independent credentials, optionally scoped, can be
   revoked one at a time, never include the email.
6. **Middleware.** XRPC handlers declare "auth required" / "optional";
   middleware loads the requester's account onto the request context.
7. **OAuth.** *Mentioned, not implemented* in this chapter — that's a
   longer thread we'd pick up later.

## Where the code goes

- `src/pds/auth/jwt.ts`
- `src/pds/auth/session.ts`
- `src/pds/auth/app_password.ts`
- `src/pds/auth/middleware.ts`
- `src/pds/xrpc/handlers/com/atproto/server/createSession.ts`
- `src/pds/xrpc/handlers/com/atproto/server/refreshSession.ts`
- `src/pds/xrpc/handlers/com/atproto/server/deleteSession.ts`

← [12 — Account creation](./12-accounts.md) · → [14 — Records](./14-records.md)
