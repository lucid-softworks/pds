# `account/`

Higher-level orchestration over the identity, repo, auth, and sequencer
subsystems. The XRPC handlers under `xrpc/handlers/com.atproto.server.*`
are thin shells around the functions here.

## Files

- [`create.ts`](./create.ts) — `createAccount({ handle, email, password,
  inviteCode?, did?, plcOp? })`. The orchestrator behind
  `com.atproto.server.createAccount`. Two flow shapes:
  - **Fresh account** (no `did`): generate keypairs, build + sign a
    genesis PLC op locally, hash password, insert account, create empty
    repo, emit `#identity` + `#account`, issue session tokens.
  - **Migrating-in account** (with `did` + `plcOp`): consume the
    matching `reserved_keys` row, validate the caller-supplied PLC op
    against the reserved key and our service endpoint, insert account
    as `migrationState='migrating-in'` + `status='deactivated'`, store
    the PLC op locally, emit events, issue tokens. `importRepo` runs
    later to populate the repo; `activateAccount` flips status to
    active.
- [`invites.ts`](./invites.ts) — `generateInviteCode`, `peekInviteCode`
  (non-mutating pre-flight), `reserveInviteCode` (guarded
  UPDATE...WHERE uses_remaining = $N decrement, race-safe),
  `createOneInviteCode`, `listInviteCodesForAccount`. Used by both the
  account creation flow (consume) and the admin / user-side mint
  endpoints (produce).

## Tables touched

- `accounts` (insert / select)
- `plc_operations` (insert genesis op or caller-supplied migrating-in op)
- `reserved_keys` (lookup + delete on migrate-in)
- `repos` + `repo_blocks` (via `createGenesisRepo` for fresh accounts)
- `repo_seq` (via `emitIdentity` / `emitAccount`)
- `invite_codes` + `invite_code_uses` (peek + reserve when gated)
- `refresh_tokens` (via `createSessionTokens`)

## Chapters

- [Chapter 12 — Account creation](../../../docs/12-accounts.md) — fresh
  account flow + invite codes.
- [Chapter 20 — Migration](../../../docs/20-migration.md) — migrating-in
  flow.
