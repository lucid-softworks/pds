# `auth/` — Sessions, tokens, app passwords, email tokens

The PDS issues short-lived **access JWTs** and longer-lived **refresh JWTs**
for client sessions. Account-protected XRPC endpoints expect the access
token in the `Authorization: Bearer …` header. **App passwords** are
alternate credentials a user can issue for headless clients. **Email
tokens** drive the confirmation, update, and password-reset flows.

## Files

- [`jwt.ts`](./jwt.ts) — sign/verify access and refresh JWTs with HS256
  via `jose`. Access tokens last ~2h; refresh tokens last ~60d.
- [`session.ts`](./session.ts) — `createSessionTokens`,
  `loginWithPassword` (handle/email/DID + main or app password),
  `rotateRefreshToken` (delete-old/insert-new), `revokeRefreshToken`,
  `findAccountByIdentifier`. Sessions opened with an app password carry
  that password's name in `refresh_tokens.app_password_name`.
- [`password.ts`](./password.ts) — `hashPassword` / `verifyPassword`,
  versioned scrypt (`scrypt:v1:N:r:p:salt:hash`).
- [`app_password.ts`](./app_password.ts) — per-account additional
  credentials. Server-generated `xxxx-xxxx-xxxx-xxxx` format (~80 bits),
  shown to the user exactly once at creation. Stored as a scrypt hash in
  the same format as the main password.
- [`middleware.ts`](./middleware.ts) — `requireAccessAuth`,
  `requireRefreshAuth`, `optionalAccessAuth`. Parses Bearer tokens,
  distinguishes `AuthMissing` / `InvalidToken` / `ExpiredToken` /
  status-specific 403s.

## Tables touched

- `accounts` — `password_hash`, `email_confirmed_at`.
- `refresh_tokens` — `jti`, `did`, `expires_at`, `app_password_name?`.
- `app_passwords` — `(did, name)`, hash, `privileged?` flag.
- `email_tokens` — `(did, purpose, token)`, single-use.

## Chapter

[**Chapter 13 — Authentication**](../../../docs/13-authentication.md).
