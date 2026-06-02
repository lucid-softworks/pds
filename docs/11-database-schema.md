# The database schema

The PDS's authoritative storage is Postgres. The MST itself isn't *in*
Postgres in any structured way — we store blocks as `(repo_did, cid, bytes)`
rows and let the MST code reconstruct trees on demand. But everything else
(accounts, sessions, the PLC operation log) is relational.

This chapter is a living reference — it grows as new subsystems land. The
shape today reflects what's needed for account creation
([chapter 12](./12-accounts.md)) and the early auth flow
([chapter 13](./13-authentication.md)).

## Tables that exist now

### `accounts`

One row per registered user. The DID is the primary key.

| Column | Type | Notes |
| --- | --- | --- |
| `did` | `text` | PK. `did:plc:...` |
| `handle` | `text` | Unique. Mutable across the account's lifetime. |
| `email` | `text` | Unique. |
| `password_hash` | `text` | Versioned scrypt hash. |
| `signing_key_priv` | `text` | Hex-encoded 32-byte k256 scalar. |
| `signing_key_pub` | `text` | Multibase Multikey. |
| `rotation_key_priv` | `text` | Hex. |
| `rotation_key_pub` | `text` | Multibase Multikey. |
| `status` | `text` | `active` \| `takendown` \| `deactivated` \| `deleted`. |
| `created_at` | `timestamptz` | |

Indexes: `accounts_handle_idx` (unique), `accounts_email_idx` (unique).

> ⚠️ **Plaintext keys.** A production PDS wraps `signing_key_priv` and
> `rotation_key_priv` in KMS, age, or libsodium-secretbox. We store hex so
> the teaching surface stays inspectable. See [chapter 18](./18-production.md).

### `repos`

One row per repository. Updates atomically with every commit (currently:
only at account creation).

| Column | Type | Notes |
| --- | --- | --- |
| `did` | `text` | PK, FK → `accounts.did`, cascade. |
| `root_cid` | `text` | Current signed-commit CID. |
| `rev` | `text` | Current commit's TID-shaped rev. |
| `created_at` | `timestamptz` | |

### `repo_blocks`

Content-addressed block storage. Every encoded MST node and every signed
commit lives here.

| Column | Type | Notes |
| --- | --- | --- |
| `repo_did` | `text` | FK → `accounts.did`, cascade. |
| `cid` | `text` | |
| `bytes` | `bytea` | DAG-CBOR-encoded block. |
| `size` | `integer` | `bytes.length`, denormalized for cheap aggregation. |
| `created_at` | `timestamptz` | |

Primary key: `(repo_did, cid)`. Secondary index: `repo_blocks_cid_idx` on
`cid` alone for cross-repo CID lookups (used by GC later).

> 📖 **Why scope blocks per repo instead of deduplicating across repos?**
> Two reasons. First, GC: when an account is deleted, `ON DELETE CASCADE`
> removes its blocks without us having to reason about which blocks are
> still referenced elsewhere. Second, audit isolation: a content-malicious
> account can't poison a CID another account references, because the lookup
> is keyed on `(repo_did, cid)` not just `cid`. Storage cost is the price.

### `refresh_tokens`

One row per outstanding refresh JWT.

| Column | Type | Notes |
| --- | --- | --- |
| `jti` | `text` | PK. The JWT's `jti` claim. |
| `did` | `text` | FK → `accounts.did`. |
| `expires_at` | `timestamptz` | |
| `app_password_name` | `text` | Nullable. Set when the session was opened with an app password. |
| `created_at` | `timestamptz` | |

Index: `refresh_tokens_did_idx` on `did` for cheap "log this user out
everywhere" (i.e. `DELETE WHERE did = ?`).

### `plc_operations`

Local copy of each account's PLC operation log. In production this would
be served from plc.directory; in our local-PLC dev mode this is the
authoritative store.

| Column | Type | Notes |
| --- | --- | --- |
| `did` | `text` | FK → `accounts.did`. |
| `cid` | `text` | CID of the signed op. |
| `operation` | `bytea` | DAG-CBOR of the signed op. |
| `seq` | `bigint` | 0 = genesis, increments per rotation. |
| `created_at` | `timestamptz` | |

Primary key: `(did, seq)`. Secondary index on `cid`.

## Migrations

Migration files are plain SQL in `/drizzle/`, applied in lexicographic
order by `src/lib/db/migrate.ts`. A tiny `__migrations` table tracks which
ones have run.

To add a migration:

1. Write `drizzle/NNNN_short_name.sql` (any leading digits work, as long as
   they sort correctly).
2. Update `src/lib/db/schema.ts` with the matching Drizzle definitions.
3. Run `pnpm db:migrate`.

We deliberately don't use `drizzle-kit generate` for now: the SQL is what
the reader audits, and seeing each migration as a hand-written file makes
the schema evolution legible chapter by chapter.

## Tables coming in future chapters

- **`records`** (ch. 14): denormalized record listing for fast `getRecord` /
  `listRecords` without having to walk the MST.
- **`blobs`** (ch. 15): blob storage metadata.
- **`record_blobs`** (ch. 15): record-to-blob references (for GC).
- **`repo_seq`** (ch. 16): the event sequencer's append-only log.
- **`app_passwords`** (ch. 13): per-session scoped credentials.

← [10 — XRPC](./10-xrpc.md) · → [12 — Account creation](./12-accounts.md)
