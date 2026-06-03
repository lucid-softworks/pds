# Backups

The PDS is the only thing in the network that has a copy of every byte
your users have ever uploaded. plc.directory holds DIDs and rotation
history; an AppView holds derived indexes it can rebuild from the
firehose; a Relay holds nothing it can't re-stream. Only the PDS is
authoritative for the actual content. Lose the PDS without a backup
and the data is gone — there's no upstream to re-fetch from.

Chapter 18 listed backups as one of the "swap dev shortcut for
production setup" items, with a one-liner: daily Postgres dump,
periodic S3 sync. This chapter is the operator's how-to: what's in a
PDS's authoritative state, how `pnpm pds:export` packages it, and how
`pnpm pds:import` restores it on a fresh deployment.

What ships here:

- `scripts/pds-export.ts` (`pnpm pds:export`) — dump everything to a
  directory.
- `scripts/pds-import.ts` (`pnpm pds:import`) — restore from one.
- This chapter. Chapter 18 now defers to it.

## What's in a PDS's authoritative state

Three categories, only the first two of which we can back up:

1. **Postgres rows.** Sixteen tables across the schema files: accounts,
   repos, repo_blocks, records, blobs, record_blobs, refresh_tokens,
   plc_operations, repo_seq, app_passwords, email_tokens, invite_codes,
   invite_code_uses, reserved_keys, oauth_par, oauth_codes. The
   accounts table is the root — every other table either FKs to it or
   stands alone (repo_seq, reserved_keys, oauth_par).

2. **Blob bytes.** Every uploaded image, video, and miscellaneous binary
   the user has attached to a record lives under `BLOB_DIR/<did>/<cid>.bin`
   (filesystem backend) or in your S3 bucket. The `blobs` table holds
   the metadata; the bytes themselves are not in Postgres.

3. **PLC operations.** plc.directory keeps the public log of every
   signed PLC op for every DID. *We* keep a local mirror in the
   `plc_operations` table because the PDS needs to be able to sign
   commits for an account without a network round-trip per signature.
   The local mirror is in category 1 — it's just a Postgres table.
   plc.directory itself is *not* our backup concern; it's the
   directory's job to be durable.

So the backup is two things: Postgres rows and blob bytes. We dump both
under one directory tree so the operator can rsync it in one shot.

## The backup shape

`pnpm pds:export --out /var/backups/pds-2026-06-02/` produces:

```
pds-2026-06-02/
├── manifest.json
├── tables/
│   ├── accounts.jsonl
│   ├── repos.jsonl
│   ├── repo_blocks.jsonl
│   ├── records.jsonl
│   ├── blobs.jsonl
│   ├── record_blobs.jsonl
│   ├── plc_operations.jsonl
│   ├── repo_seq.jsonl
│   ├── app_passwords.jsonl
│   ├── invite_codes.jsonl
│   ├── invite_code_uses.jsonl
│   └── reserved_keys.jsonl
└── blobs/
    └── did:plc:abc.../bafy....bin
```

Two design choices worth justifying:

**JSONL, not one big JSON array.** Each row is one self-contained line.
You can `head -n 5 tables/accounts.jsonl | jq` to peek at the schema
without parsing the whole file; you can stream-process billions of rows
without ever holding more than one in memory; partial files from a
crashed export are still parseable up to the truncation point.

**A directory, not a tarball.** Node has no portable stdlib for
emitting tar without an extra dependency, and shelling out to the
system `tar` would lock the script to Unix. A directory is honest about
platform portability and keeps the script tiny — the operator runs
`tar czf pds-2026-06-02.tar.gz pds-2026-06-02/` themselves if they want
a single artifact for transport. Most production setups will pipe the
tarball straight into `aws s3 cp -`.

Manifest contents:

```json
{
  "version": "1",
  "exportedAt": "2026-06-02T19:43:12.000Z",
  "source": {
    "publicUrl": "https://pds.example.com",
    "hostname": "pds.example.com",
    "blobStoreKind": "filesystem"
  },
  "schemaHash": "8fd9f03d8e5b9...",
  "includedTokens": false,
  "tables": [{"name": "accounts", "rows": 312}, ...],
  "blobCount": 4815,
  "blobBytes": 1822931741
}
```

The `schemaHash` field is the load-bearing one — see below.

## What we exclude by default

Four tables hold short-lived secrets that a fresh deployment can
recreate on its own:

| Table | TTL | What rotation looks like |
| --- | --- | --- |
| `refresh_tokens` | days–weeks | Users sign in again, get fresh JWTs |
| `email_tokens` | 24h | User requests a new "confirm email" link |
| `oauth_par` | ~60s | OAuth client retries the PAR submission |
| `oauth_codes` | ~60s | OAuth client retries the authorize redirect |

Restoring these is *legal* — the schema accepts them — but it's
pointless work that briefly extends the lifetime of credentials that
should have been rotated anyway. So the default is to drop them at
export time. Pass `--include-tokens` if you really need a full
roundtrip (running a hot-failover or doing a forensic restore where
existing sessions matter).

The exclusion is recorded in the manifest's `includedTokens` field, so
an operator inspecting a backup six months later can tell what they're
looking at.

## Schema-hash gate

`pds-import` refuses to load a backup whose `schemaHash` doesn't match
the `drizzle/*.sql` corpus on the destination.

The hash is a sha256 of the concatenated migration files, sorted by
name. Any change to a schema — a new column, a new table, a tweaked
default — changes the hash. If the source PDS was on chapter-19's
schema (10 migrations) and the destination is on chapter-21's (11
migrations), the hash differs and we bail.

Why be strict about this? Because the JSONL files encode rows as
drizzle's TypeScript shape, and a column that exists on one side but
not the other would fail silently in subtle ways: `INSERT` into a table
that's missing a NOT-NULL column would error halfway through the
table; `INSERT` into a table that has *extra* NOT-NULL columns would
fail on the first row, but only after we'd already started a multi-row
batch. Refusing up front means the operator gets a clear message
("export is from a different schema version; migrate the source PDS to
current version first, or downgrade this PDS") instead of a half-loaded
database.

The fix when it fires:

- If your destination is *newer* than the export: run `pnpm db:migrate`
  on the source PDS to bring it forward, re-export, retry.
- If your destination is *older* than the export: check out the matching
  git commit, re-migrate (the migrations are append-only and the journal
  table notices what's already applied), retry.

## Restore semantics

`pds-import` is **idempotent on an empty target** and **refuses on a
populated one** without `--force`.

On startup, we check whether `accounts` has any rows. If it does, we
exit with a message about the conflict risk. The reasoning: importing
on top of an existing PDS would collide on primary keys, leave the DB
half-merged, and almost certainly is not what the operator meant.
Two-PDS merge isn't a supported workflow — if you need to consolidate
two PDS deployments, migrate each user out individually using
chapter 20's account-migration flow.

`--force` is provided for the genuine case (importing a fresh PDS that
happened to get poked at — say you created a test account, want to
discard it, and load from a backup). Use sparingly.

Insert order follows the FK topo sort:

```
accounts → repos, repo_blocks, records, blobs, record_blobs,
           refresh_tokens, plc_operations, app_passwords,
           email_tokens, oauth_codes, invite_codes
           ↓
           invite_code_uses (→ invite_codes)

(no FK):   repo_seq, reserved_keys, oauth_par
```

Same order as `pds-export.ts`. The bigserial sequence behind
`repo_seq.seq` is realigned after the table is restored — explicit
inserts bypass the sequence, leaving its counter at zero, so the next
natural insert would collide with the restored `seq=1`. We
`SELECT setval('repo_seq_seq_seq', MAX(seq))` at the end of that
table's restore to fix this.

## What's NOT backed up

- **plc.directory entries.** The directory holds the public log of
  signed PLC ops. Our local `plc_operations` mirror is exported, but
  the directory itself isn't ours to back up. If you nuke the local
  mirror and republish to plc.directory, the directory will reject
  duplicates (same DID, same operation hash) and accept gaps if the
  rotation chain matches — but you should not be in this situation
  outside of catastrophic data loss.

- **S3 blob bytes.** If you've moved off filesystem to `BLOB_STORE=s3`,
  this script's `blobs/` directory is empty and the bucket is your
  blob backup. Use `aws s3 sync` to a second-region bucket on a
  schedule independent of the row dump.

- **`__migrations` table.** The migration journal isn't part of the
  export. Each destination PDS tracks its own migration state, and the
  schema-hash gate ensures both sides are in sync without copying the
  journal.

- **Configuration.** `PDS_JWT_SECRET`, `PDS_OAUTH_SIGNING_KEY`,
  `PDS_ADMIN_PASSWORD_HASH`, the rest of `process.env`. Restoring with
  a fresh JWT secret invalidates every existing access token on the
  restored PDS, which is *also* a good reason to default-exclude
  refresh tokens — they'd be unusable anyway.

## Try it

End to end on a fresh PGlite:

```bash
# 1. Export from the live PDS.
pnpm pds:export --out /tmp/bkp

# 2. Set up a clean destination.
mkdir /tmp/pds-restore
DATABASE_URL=pglite:/tmp/pds-restore/db \
BLOB_DIR=/tmp/pds-restore/blobs \
PDS_JWT_SECRET=... \
pnpm db:migrate

# 3. Restore.
DATABASE_URL=pglite:/tmp/pds-restore/db \
BLOB_DIR=/tmp/pds-restore/blobs \
PDS_JWT_SECRET=... \
pnpm pds:import /tmp/bkp

# 4. Boot the restored PDS, sign in, browse the firehose, confirm.
DATABASE_URL=pglite:/tmp/pds-restore/db \
BLOB_DIR=/tmp/pds-restore/blobs \
PDS_JWT_SECRET=... \
pnpm dev
```

A handful of follow-up checks worth running by hand:

- `getRecord` for a known record on the restored PDS returns the same
  CID it did on the source.
- The firehose cursor on the restored PDS picks up at the same `seq` —
  download `/xrpc/com.atproto.sync.subscribeRepos?cursor=0` and diff
  the first few events.
- The blob CID stored in a known record can be downloaded via
  `getBlob` without error.

If any of these fail, the backup didn't roundtrip cleanly; open an
issue with the manifest.

## Production cadence

A reasonable schedule for a single-node PDS:

| Frequency | Action |
| --- | --- |
| Continuous | Postgres WAL archive (your provider, or pgBackRest) |
| Hourly | `pnpm pds:export` to `/var/backups/pds-<isodate>/` |
| Hourly | `aws s3 sync /var/backups/ s3://your-bucket/pds-backups/` |
| Daily | Rotate local backups older than 7 days |
| Weekly | Cross-region S3 replication (managed by AWS) |
| Quarterly | Full restore drill on a staging PDS |

The hourly cadence is comfortable because the export is incremental in
the rsync sense: blob files are content-addressed, so `s3 sync` only
uploads new CIDs. The JSONL table dumps re-emit every time, but
they're text and they gzip well — a 100k-account PDS is roughly 50 MB
gzipped.

The quarterly restore drill is the one most operators skip. Don't.
The day you find out your backups aren't valid is the day you needed
them.

## Where to go from here

Two refinements this script deliberately doesn't ship:

- **Incremental dumps.** The current export rewrites every table on
  every run. For a TB-scale PDS, an incremental mode that only dumps
  rows newer than the last successful export would be a clear win.
  Track the watermark in `manifest.json`, filter each query by
  `created_at > watermark` (or `seq > watermark` for `repo_seq`).

- **Encryption at rest.** The dump contains password hashes, signing
  keys, and email addresses. A real production deploy should pipe the
  tarball through `age` or `gpg` before it touches the bucket. The
  operator's encryption key lives outside our scope, but a documented
  pipeline (`pnpm pds:export | tar c | age -r ... | aws s3 cp -`) is
  worth adding.

Both are tractable. If you ship them, send a PR.

← [22 — Client UI](./22-client-ui.md) ·
[Table of contents](./README.md)
