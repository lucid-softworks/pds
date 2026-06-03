# Account creation and did:plc

This is the longest single endpoint in the PDS. Registering an account
touches every load-bearing subsystem at least once: identity, signing,
content-addressed storage, repository commits, session issuance. By the
time it returns a 200 you've crossed almost the entire codebase. This
chapter walks the full path.

## The XRPC endpoint

The contract is `com.atproto.server.createAccount`. The full upstream
lexicon supports invites, recovery keys, account migration, and a
caller-supplied PLC operation. We currently support the simplest variant —
brand-new self-hosted account — and stub the rest.

The request a Bluesky client sends looks roughly like:

```http
POST /xrpc/com.atproto.server.createAccount HTTP/1.1
Content-Type: application/json

{
  "handle": "alice.test",
  "email": "alice@example.com",
  "password": "correcthorsebatterystaple"
}
```

And the response we return:

```json
{
  "did": "did:plc:g7k4q6y6jmrr3hgpwxs4f5n2",
  "handle": "alice.test",
  "accessJwt": "eyJhbGciOi...",
  "refreshJwt": "eyJhbGciOi...",
  "didDoc": {
    "id": "did:plc:g7k4q6y6jmrr3hgpwxs4f5n2",
    "alsoKnownAs": ["at://alice.test"],
    "verificationMethod": [...],
    "service": [...]
  }
}
```

By the time the client has those four strings it can use any account-
authenticated XRPC method on this PDS.

## The orchestration function

`src/pds/account/create.ts` is the conductor. Its `createAccount(input)`
function does the steps in order:

```
 ┌─ 1. Validate handle / email / password syntax
 ├─ 2. Check uniqueness
 ├─ 3. Generate signing keypair + rotation keypair
 ├─ 4. Build + sign genesis PLC op → derive DID
 ├─ 5. Hash password
 ├─ 6. Insert account row
 ├─ 7. Build empty MST + signed commit; persist blocks
 └─ 8. Issue access + refresh JWTs
```

The handler in `src/pds/xrpc/handlers/com.atproto.server.createAccount.ts`
is intentionally thin: validate input shape with zod, call `createAccount`,
return its result. The actual logic is in `account/create.ts` so it can be
unit-tested without an HTTP layer.

Let's walk each step.

## Step 1 — Validate

`src/pds/did/handle.ts` enforces the [handle syntax
rules](https://atproto.com/specs/handle):

- 3–253 characters.
- Lowercase ASCII alphanumeric + hyphens, no leading/trailing hyphens.
- At least two labels (e.g. `alice.test`, never just `alice`).
- TLD can't be numeric-only.

Reserved TLDs (`.local`, `.invalid`, `.test`, ...) get a warning but aren't
hard-blocked, because in dev we *want* `alice.test` to work. The real
production check would reject those.

Email gets a permissive regex (anything-at-anything-dot-anything). The
password floor is 8 characters.

> ⚠️ **Difference from upstream.** The reference PDS sends a verification
> email and gates account activation until the user clicks the link. We
> don't — accounts are active immediately. Email verification is a
> follow-on chapter.

## Step 2 — Uniqueness

A simple `SELECT did FROM accounts WHERE handle = ?` and the same for
email. Both columns have unique indexes (in `drizzle/0000_init.sql`), so
even if two requests race past this check, the database insert in step 6
will fail with a unique-violation that we surface as `Conflict`.

## Step 3 — Generate keys

Two keypairs:

- **Signing key** — what the PDS uses to sign repo commits on the user's
  behalf. Registered in the DID document's `verificationMethod[#atproto]`.
  Lives forever (per account).
- **Rotation key** — controls future PLC operations against this DID.
  Conceptually it's the "root" key; if the user moves to a different PDS,
  the rotation key is what authorizes the migration. The signing key can
  be rotated; the rotation key can also be rotated, but with itself.

Both are secp256k1 / k256 keypairs generated in `src/pds/repo/keys.ts`. The
implementation is just `@noble/curves`:

```ts
const priv = secp256k1.utils.randomPrivateKey()
const pub = secp256k1.getPublicKey(priv, true)  // compressed, 33 bytes
```

For wire/storage we encode the public key as a **Multikey**: a multicodec
varint prefix (`0xe7 0x01` for secp256k1) plus the 33-byte compressed
pubkey, then multibase-base58btc-encoded with a `z` prefix:

```
z6MkpTHR8VNsBxYAAWHut2Geadd9jSshBHR8VnogtoFp1RZ8r
└┬┘ └────────────────────┬────────────────────┘
 multibase z (base58btc)  varint(0xe7) || compressed-pubkey
```

The same encoding becomes the `did:key:` form simply by prepending the
string: `did:key:z6Mk...`. We use that in the PLC operation, then strip the
prefix to put the bare Multikey into the DID document.

> ⚠️ **The signing keys are stored plaintext in Postgres.** In production
> you'd wrap these in a KMS or an age-encrypted column. The teaching port
> stores them as hex strings in `accounts.signing_key_priv` so you can see
> the whole flow with one `SELECT`.

## Step 4 — The PLC operation

This is the conceptual centerpiece. In production, the PDS POSTs a signed
"genesis operation" to plc.directory; the directory hashes the signed bytes
to derive the DID, stores the op in an append-only log keyed by that DID,
and from then on resolves the DID to its current document.

Our `src/pds/did/plc.ts` builds the *same* operation with the *same*
signature, but skips the POST. We persist the op locally in
`plc_operations` and resolve our own DIDs by reading the `accounts` table
back.

The unsigned operation looks like:

```ts
{
  type: "plc_operation",
  rotationKeys: ["did:key:z6Mk... (rotation)"],
  verificationMethods: { atproto: "did:key:z6Mk... (signing)" },
  alsoKnownAs: ["at://alice.test"],
  services: {
    atproto_pds: {
      type: "AtprotoPersonalDataServer",
      endpoint: "https://this-pds.example"
    }
  },
  prev: null
}
```

We DAG-CBOR-encode that, sign the bytes with the rotation key
(`signBytes(rotationKeyPriv, unsignedBlock.bytes)`), base64url-encode the
signature, and append it as `sig`. Then we DAG-CBOR-encode the *signed* op
and hash that with SHA-256. The first 15 bytes of the hash, base32-encoded
and truncated to 24 characters, becomes the method-specific id of the DID:

```
did:plc:g7k4q6y6jmrr3hgpwxs4f5n2
        └──── base32(sha256(signed-op))[..24] ────┘
```

> 📖 **Why two encodings?** The first encoding (unsigned op → bytes →
> signature) is the cryptographic commitment: the signature is over those
> specific bytes. The second encoding (signed op → bytes → hash → DID) is
> the addressing scheme: the DID is the hash of *exactly* the bytes the
> directory will store. So if the directory's bytes ever differ from ours,
> we know — they don't hash to the same DID anymore.

> ⚠️ **Difference from upstream.** In the default dev mode
> (`PDS_LOCAL_PLC=true` or unset) our DIDs aren't published; they're
> resolvable from this PDS only and a relay can't look them up. Setting
> `PDS_LOCAL_PLC=false` flips the publish step on: `createAccount` POSTs
> the signed genesis op to `https://plc.directory/<did>` between
> persisting locally and emitting the firehose event, and `updateHandle`
> does the same for rotation ops. The remaining caveat is that publishing
> is single-attempt with one 250 ms retry — a 5xx run during an outage
> will fail the whole signup and roll back. Production should add a
> durable job queue that retries the publish off the request path. See
> chapter 18 — Production.

> 📖 **Migrating accounts.** The flow above generates the keys, signs the
> genesis op, and derives a fresh DID. The other entry point — a user
> moving from another PDS — *brings their existing DID*. They pre-reserve
> a signing key on this PDS, build and sign a PLC *rotate* op (still
> signed with their long-lived rotation key, not anything we hold) that
> points `verificationMethods.atproto` at our reserved key and the
> `atproto_pds` service at our `publicUrl`, then hand both to
> `createAccount` as `did` + `plcOp`. We adopt the DID, persist the op as
> the local genesis (seq 0 — the upstream chain stays on the old PDS in
> local-PLC mode), consume the reservation, and park the account in
> `deactivated` state. The repo lands later through `importRepo`, which
> activates the account once the imported commit verifies. See chapter
> 20 — Migration.

## Step 5 — Hash the password

`src/pds/auth/password.ts` runs **scrypt** via `node:crypto`. Parameters:
N=2^15, r=8, p=1 — roughly 32 MB memory, ~150ms on modern hardware. The
stored format is versioned:

```
scrypt:v1:32768:8:1:<salt-b64>:<hash-b64>
```

Versioning the parameters means a future migration can re-hash with
stronger settings (`scrypt:v2:...`) without breaking verification of
existing rows; we keep both parsers around until the migration completes.

> 📖 **Why scrypt, not argon2id?** Argon2id is the modern recommendation,
> but every JS implementation requires a native build or a WASM bundle. For
> a teaching project that should `pnpm install` cleanly with zero native
> compilation, `node:crypto.scrypt` wins. The cost is that argon2's
> memory-hardness against custom ASICs is stronger; that matters more in
> 2026 than it did in 2016, but scrypt is still a perfectly acceptable
> floor.

## Step 6 — Insert the account row

A single `INSERT INTO accounts (...) VALUES (...)`. The unique indexes on
`handle` and `email` are the last line of defense against races; if
they fail, we catch and surface `Conflict`.

## Step 7 — Build the empty signed repo

This is where the codec, MST, and commit modules earn their keep.

The repository starts empty. Per the spec, an empty MST is still a real
node — `{ l: null, e: [] }` — which we DAG-CBOR encode and CID via
`src/pds/repo/mst.ts → emptyMst()`. That gives us our `data` CID.

Then `src/pds/repo/commit.ts → buildSignedCommit({ did, data, rev, signingKeyPriv })`
builds the commit object, signs the unsigned bytes with the signing key,
and re-encodes the signed result:

```ts
const unsigned = { did, version: 3, data, rev, prev: null }
const unsignedBlock = await encode(unsigned)
const sig = signBytes(signingKeyPriv, unsignedBlock.bytes)
const signed = { ...unsigned, sig }
return await encode(signed)
```

The CID of the *signed* commit is the repo's root CID. Both blocks (the
empty MST node + the signed commit) go into `repo_blocks`. The `repos`
table gets a single row recording `(did, root_cid, rev)`.

> 📖 **Why store the unsigned + signed forms separately for hashing?**
> Because the signature has to be over deterministic bytes. If we just
> said "sign the dict containing sig=null and then replace null with the
> sig," any encoder difference (key ordering, length encoding) would break
> verification. Encoding twice — once without `sig` to sign, once with
> `sig` to publish — sidesteps it entirely.

## Step 8 — Issue the session

`src/pds/auth/session.ts → createSessionTokens(did)`:

1. Mint an **access JWT** (HS256, 2 hour expiry, scope
   `com.atproto.access`, subject = DID).
2. Mint a **refresh JWT** (HS256, 60 day expiry, scope
   `com.atproto.refresh`).
3. Insert the refresh token's `jti` into `refresh_tokens` so we can revoke
   it later (logout, password change, suspicion).

Access tokens are *not* stored; they're stateless to verify. Only refresh
tokens have a server-side record, because revocation is the only thing that
makes refresh tokens better than access tokens.

The two JWTs are returned alongside the user's DID and the freshly-built
DID document. The client now has everything it needs.

## Handle rotation later

Once an account exists, the user can rename it via
`com.atproto.identity.updateHandle`. The handler reuses the same machinery
the genesis op did, just chained one step further down the log:

1. **Authenticate.** `requireAccessAuth` resolves the bearer JWT to the
   account row.
2. **Validate.** The new handle goes through `assertValidHandle`; reserved
   TLDs warn but pass (mirroring create). If the requested handle equals the
   current one we return 200 immediately — no-op rotations don't pollute
   the log.
3. **Check availability.** `resolveLocalHandle(newHandle)` — if it resolves
   to a different DID, return `HandleNotAvailable` (HTTP 409).
4. **Rotate the PLC log.** `rotatePlc({ did, newHandle, rotationKeyPriv })`
   loads the latest op, copies its keys + service endpoint, swaps
   `alsoKnownAs` to the new handle, sets `prev` to the previous op's CID,
   signs with the rotation key, and appends to `plc_operations` with the
   next `seq`.
5. **Update the column.** `UPDATE accounts SET handle = ?` inside the same
   `db.transaction` as step 4 so a failure on either side rolls both back.
6. **Announce.** `emitIdentity({ did, handle })` writes an `#identity`
   event to the firehose so any subscriber re-resolves the document.

The DID never changes — it was hashed off the *genesis* op, and rotations
append rather than replace. Neither does the signing key, so existing repo
commits keep verifying against the same public key. The cost of a rename is
one row in `plc_operations`, one column update on `accounts`, and one
firehose event.

The other two identity endpoints in the lexicon —
`requestPlcOperationSignature` and `signPlcOperation` — are the escape
hatch for caller-driven rotations (key changes, recovery key adds, PDS
migration). They ship as `MethodNotImplemented` stubs and land in a future
chapter alongside account migration.

## Failure handling

The function is *almost* idempotent but not quite — we don't wrap steps 6
through 8 in a Drizzle transaction. So the windows where a partial failure
could leave dangling state are:

1. **PLC op written, account row insert fails.** We catch and best-effort
   delete the orphan `plc_operations` row. Idempotency tag: the DID will
   be a different hash if the user retries (the rotation key is freshly
   generated), so no collision.
2. **Account row inserted, repo creation fails.** The next time the user
   creates an account it'll fail with `HandleNotAvailable`. We catch and
   delete the account row; the FK cascade also clears any partial
   `repo_blocks`.
3. **Repo committed, JWT issuance fails.** This is the awkward one — the
   account exists, the repo exists, but the user didn't get tokens. They
   can call `createSession` with the password they just set and proceed.

A proper transaction is a follow-up chapter. The shape of `createAccount`
makes it straightforward to wrap once we have the transaction primitives in
place.

## Invite codes

By default the PDS accepts signups from anyone with a valid handle. That's
the right policy for a learning environment and for any operator who wants
their server to behave like the public ones. It is not the right policy for
a private PDS — a handful of friends, a family group, a research cohort —
where you'd rather the front door require a key.

Setting `PDS_INVITE_REQUIRED=true` flips the gate. After that env var
change, every call to `createAccount` must include a valid `inviteCode` or
it returns `InvalidInviteCode` (HTTP 401) and never touches the database.

### Code shape

Codes look like `pds-x2k4g-9p3qm`: a literal `pds-` prefix, then two
five-character groups of lowercase base32, separated by a hyphen. The ten
data characters carry ~50 bits of entropy, drawn from
`crypto.randomBytes(8)` and base32-encoded via the same
`multiformats/bases/base32` package the PLC module uses. At ~10¹⁵ possible
codes, brute-forcing one isn't tractable against the rate limits any sane
operator will apply.

The format isn't load-bearing — it's just a short, human-typable string.
The database has no opinion on its shape beyond uniqueness; if a future
chapter wants to add per-PDS branding (`mypds-...`) the schema doesn't need
to change.

### Two ways to mint

**Admin-side.** The operator authenticates with the configured admin
password (Basic auth, chapter 19) and calls
`com.atproto.server.createInviteCode` for a single code or
`createInviteCodes` to bulk-mint. Both accept an optional `useCount`
(default 1) and an optional recipient binding — either `forAccount: did`
on the single endpoint, or a `forAccounts: did[]` array on the bulk one.
Recipient-bound codes work like a personal invitation: only the named DID
can redeem them, so handing out the same string twice doesn't matter.

**User-side.** Every active account is supposed to receive a small
recurring quota of personal codes — that's how Bluesky's invite tree
worked, with each account able to mint a few codes per N days. We've shipped
the storage and the `getAccountInviteCodes` query for it, but not yet the
auto-issuance cron that fills `invite_codes` rows attributed to each
account. A follow-up chapter (or your own exercise — see below) wires that
up; for now, `getAccountInviteCodes` returns whatever codes the operator
manually attributed to the caller, if any.

### Enforcement in `createAccount`

There's one subtle correctness problem: the DID we'd hand the new account
isn't known until *after* `createLocalPlc` runs. If we consumed the invite
code up front, a downstream failure (key collision in the unique handle
index, repo build crash) would burn the code on a signup that never landed.
If we consumed it at the end, we'd validate something that's already moved
under our feet.

The orchestrator splits the work in two:

```
1.  validate input
2.  check handle/email uniqueness
2b. peekInviteCode      ← look but don't touch
3.  generate keys
4.  build PLC op → derive DID
5.  hash password
6.  insert account row
6b. reserveInviteCode   ← decrement + audit
7.  build empty signed repo
8.  issue access + refresh JWT
```

`peekInviteCode` is a pure read: it confirms the code exists, isn't
disabled, has uses remaining, and (if `forAccount` is set) hasn't been
reserved for someone else. `reserveInviteCode` re-runs the same checks
under a guarded `UPDATE ... WHERE uses_remaining = $expected` decrement,
then writes an `invite_code_uses` audit row. If two requests race past the
peek with the last available use, exactly one wins; the loser sees the same
`InvalidInviteCode` error a brand-new failed lookup would return.

The `forAccount` recipient check runs in both passes, but only the second
pass has a DID to compare against. The first pass can still reject obviously
broken inputs — wrong code, exhausted, disabled — before we waste a PLC op.

### Try it

In a gated PDS (`PDS_INVITE_REQUIRED=true` set in the environment), mint a
code as the operator first:

```bash
ADMIN_AUTH=$(printf 'admin:%s' "$PDS_ADMIN_PASSWORD" | base64)

curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createInviteCode \
  -H "authorization: Basic $ADMIN_AUTH" \
  -H 'content-type: application/json' \
  -d '{"useCount": 1}'
# → {"code":"pds-x2k4g-9p3qm"}
```

Sign up with that code:

```bash
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{
    "handle": "alice.test",
    "email": "alice@example.com",
    "password": "correcthorsebatterystaple",
    "inviteCode": "pds-x2k4g-9p3qm"
  }'
# → 200, full account payload
```

Re-using the same code returns `InvalidInviteCode`:

```bash
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{
    "handle": "bob.test",
    "email": "bob@example.com",
    "password": "correcthorsebatterystaple",
    "inviteCode": "pds-x2k4g-9p3qm"
  }'
# → {"error":"InvalidInviteCode","message":"invite code exhausted"}
```

Omitting `inviteCode` while gated returns the same error name with a
different message. Setting `PDS_INVITE_REQUIRED=false` (or unset) restores
open signup; the code field is ignored when present.

## Try it

After `pnpm db:migrate && pnpm dev`:

```bash
curl -i -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{
    "handle": "alice.test",
    "email": "alice@example.com",
    "password": "correcthorsebatterystaple"
  }'
```

You should see a 200 with a JSON body containing your new DID, handle, two
JWTs, and the DID document. Try the same call twice — the second one
should 409 with `HandleNotAvailable`.

To inspect the state:

```bash
DATABASE_URL=pglite pnpm drizzle-kit studio
```

…and browse `accounts`, `repos`, `repo_blocks`, `plc_operations`,
`refresh_tokens`.

## Exercises

1. The genesis PLC op is signed with the *rotation* key, not the signing
   key. Why? What would break if we used the signing key?
2. Read the bytes of an MST block (`SELECT bytes FROM repo_blocks WHERE
   size < 30 LIMIT 1`). Decode it as DAG-CBOR by hand — you should get
   `{ l: null, e: [] }`.
3. Verify a signed commit yourself: fetch its bytes from `repo_blocks`,
   strip the `sig` field, re-encode, and check the signature against the
   account's `signing_key_pub`. (The plumbing for this exists in
   `commit.ts → verifyCommit`.)
4. Why is the password floor 8 characters? What attack does that defend
   against, and what attack does it *not* defend against?

## Up next

We have authenticated sessions. The next two chapters fill in [13 —
Authentication](./13-authentication.md) (refresh, logout, app passwords)
and [14 — Records](./14-records.md) (actually putting data into the empty
repo we just created).
