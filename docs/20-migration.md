# Migration

A user's DID lives on a third-party log (plc.directory) and points at a
PDS. That arrow is the only thing tying a DID to a host. Rotate the arrow
and the user has *moved* — same DID, same handle, same followers, new
hostname signing their commits. The PDS doesn't own the user; it just
holds bytes on their behalf.

This chapter is the choreography that makes that real. Two PDSes have to
hand a repository between them with nobody on the network noticing
anything other than the new endpoint in the DID document. The rest of the
book has built every part we need. This chapter glues them together.

## What this PDS plays both sides of

This PDS speaks both halves of the migration protocol. Source side:

- `com.atproto.sync.getRepo` — chapter 08 shipped this. It hands out a
  CAR of the full repository.
- `com.atproto.server.getServiceAuth` — new in this chapter. Mints a
  short-lived JWT the destination PDS can present when it pulls the repo.
- `com.atproto.server.activateAccount` — chapter 12. The flip-side mark
  ("I'm done over here, you take over") is a one-line follow-up; the
  current flow is the destination calling activate, not the source
  calling deactivate. We'll come back to that gap.

Destination side:

- `com.atproto.server.reserveSigningKey` — new. Holds a server-generated
  signing key for a soon-to-arrive DID so the migrating user can stitch
  it into their PLC rotate op.
- `com.atproto.server.createAccount` — chapter 12. Accepts a pre-existing
  `did` + signed `plcOp` and parks the account in `deactivated` state
  until `importRepo` lands the bytes. See "Receiving a migrating account"
  below.
- `com.atproto.repo.importRepo` — new. Takes the CAR the user downloaded
  from the source and ingests it as the destination repo's state.
- `com.atproto.sync.listMissingBlobs` — new. Reports the blob CIDs the
  imported records reference but the destination blob store doesn't have
  bytes for yet.
- `com.atproto.repo.uploadBlob` — chapter 15. The user POSTs each missing
  blob in turn.
- `com.atproto.server.activateAccount` — chapter 12. Flips the new
  account to `active` once everything has landed.

The set of endpoints lines up symmetrically because *the protocol is the
choreography*. Each PDS speaks its half; the user's client owns the
orchestration.

## The choreography, step by step

Imagine Alice on the old PDS (`source.example`) is moving to the new PDS
(`dest.example`). Her DID is `did:plc:alice...`. The order of operations
her client follows:

1. **Log in to the old PDS.** Standard session, nothing migration-specific.
2. **Reserve a signing key on the new PDS.**
   `POST /xrpc/com.atproto.server.reserveSigningKey { "did": "did:plc:alice..." }`.
   The new PDS generates a fresh k256 keypair, stores the private half in
   `reserved_keys`, and returns the Multikey-encoded public half:
   `{ "signingKey": "z6Mk..." }`.
3. **Build a PLC rotate op locally.** The new op keeps Alice's rotation
   key (she still controls her identity) but swaps:
   - `verificationMethods.atproto` → the new signing key from step 2.
   - `services.atproto_pds.endpoint` → `https://dest.example`.

   The rotate op references the previous op's CID as its `prev`, so
   plc.directory can verify it chains correctly.

4. **Publish the rotate op.** In production, POST it to plc.directory and
   the global view updates. In our local-PLC mode, append it to
   `plc_operations` on whichever side the client decides — this is one
   of the gaps below; we don't sync the local PLC log between PDSes.

5. **Mint a service token on the old PDS.**
   `GET /xrpc/com.atproto.server.getServiceAuth?aud=did:web:dest.example&lxm=com.atproto.sync.getRepo`.
   The old PDS returns a JWT whose `iss` is Alice's DID, `aud` is the
   destination service, `lxm` scopes it to one method, and `exp` caps at
   60 seconds. The token lets the destination present *Alice's authority*
   to the source when it pulls.
6. **Create the destination account.** `POST /xrpc/com.atproto.server.createAccount`
   with Alice's existing DID and the signed plcOp from step 3. The
   destination validates the op (the `atproto` verification method must
   match the key we just reserved; the service endpoint must match our
   `publicUrl`; the handle in `alsoKnownAs[0]` must match the request),
   persists it as the local PLC genesis (seq 0 — the upstream chain
   stays on the old PDS), consumes the reservation, inserts the account
   row with `status='deactivated'` and `migration_state='migrating-in'`,
   and hands back a session.
7. **Download the source repo as a CAR.** `GET /xrpc/com.atproto.sync.getRepo?did=...`,
   carrying the service token from step 5 as `Authorization: Bearer ...`.
   The response is a CAR of every block reachable from the current commit.
8. **Import the CAR into the destination.** `POST /xrpc/com.atproto.repo.importRepo`
   with the CAR as the binary body and the new account's session as auth.
   The destination verifies the commit signature against the reserved
   signing key, persists every block, rebuilds the records + record_blobs
   indexes, and emits a `#commit` firehose event.
9. **Reconcile blobs.** `GET /xrpc/com.atproto.sync.listMissingBlobs`. For
   each `{ cid, recordUri }` it returns, Alice's client downloads the
   blob from the source PDS (`com.atproto.sync.getBlob`) and uploads it
   to the destination (`com.atproto.repo.uploadBlob`). Loop until the
   list is empty (paginate with `cursor`).
10. **Activate.** `POST /xrpc/com.atproto.server.activateAccount` on the
    destination. The account flips from `deactivated` to `active`; the
    firehose announces `#account { active: true }`.

That's the protocol. Two new POSTs (`reserveSigningKey`, `importRepo`),
two new GETs (`getServiceAuth`, `listMissingBlobs`), all the existing
read paths, and one rotate op against the PLC.

## The signing key handoff

Why does the *destination* generate the signing key, instead of the user
generating it locally and handing both halves over? Because the PDS has
to sign commits on the user's behalf the moment a write lands — meaning
the private key has to live on the server, not in the client. If the
user generated it locally, they'd have to ship the private half over the
wire to the new PDS to make any writes work. Generating it server-side
keeps the private half from ever leaving the destination, the same way
it never left the source.

The reservation is bookkeeping. At step 2 the account doesn't exist yet,
so we can't put the key in `accounts.signing_key_priv`. The
`reserved_keys` table is the holding pen: keyed by DID with no foreign
key (the account row doesn't exist), waiting for a future
`createAccount` call that recognizes a pre-existing DID and pulls the
reservation in.

The reservation is consumed by `createAccount` once the user shows up
with their DID + signed `plcOp`. At that point the private key moves from
`reserved_keys.signing_key_priv` to `accounts.signing_key_priv` and the
reserved row is deleted. If the user never returns, the orphaned row sits
harmlessly until a re-run of `reserveSigningKey` overwrites it (or until
operator cleanup prunes stale reservations).

The user's *rotation* key is a different story. That key controls future
PLC operations against the DID; the user keeps it (in their client, on
hardware, wherever) and only ever uses it to sign rotate ops. Migrations
never rotate the rotation key — that would lock the user out if the new
PDS turned hostile.

## What `migration_state` is for

The new column on `accounts` carries one of three values:

- `none` — the default, ordinary write traffic.
- `migrating-out` — the user is in the middle of leaving this PDS. We
  haven't wired anything to flip this yet (that's the source-side
  deactivate gap).
- `migrating-in` — `importRepo` set this after a successful import.

The reason to spend a column on it: the firehose `#commit` event that
follows `importRepo` is *not* an ordinary commit. Every record looks
like a `create` to downstream consumers — there's no `prev` to compare
against on this PDS — but the rev is a rev the consumer may already have
indexed from the *old* PDS's firehose. Tagging the account state lets
the firehose surface "this is a migration commit, treat every op as a
re-binding, not a new write." We don't emit that label yet; the column
is groundwork.

## The four new endpoints

### `com.atproto.server.getServiceAuth`

Code: `src/pds/xrpc/handlers/com.atproto.server.getServiceAuth.ts`.

GET, requires the caller's access token. Query parameters:

- `aud` (required) — the target service DID.
- `lxm` (optional) — the lexicon method NSID this token authorizes.
- `exp` (optional) — desired expiry as unix-seconds. Capped at 60 seconds
  out.

Output: `{ token: "<jwt>" }`.

We sign with HS256 using the shared `PDS_JWT_SECRET`. The claims:

```
iss = <user DID>
aud = <target service DID>
lxm = <method NSID>     (if provided)
iat = <now>
exp = <now + ttl>
jti = <random base64url>
```

> ⚠️ **Spec divergence.** Real atproto service tokens are signed with
> ES256K using the user's own signing key; the receiver verifies against
> the user's DID document. Our HS256 tokens only verify against the
> shared PDS secret, which is fine for self-issued tokens this same PDS
> consumes but **does not federate**. The shape (iss/aud/lxm/exp) is
> identical; swap the signer to `signBytes(account.signingKeyPriv, ...)`
> + the matching verify step in `auth/middleware.ts` to make this work
> across PDSes.

### `com.atproto.server.reserveSigningKey`

Code: `src/pds/xrpc/handlers/com.atproto.server.reserveSigningKey.ts`.

POST, optional access auth. Body: `{ did?: string }`. If the caller is
authenticated we link the reservation to their DID; otherwise the body
must supply one — the migrating user doesn't *have* a session on the
destination PDS yet.

Output: `{ signingKey: "z6Mk..." }`.

The handler:

```ts
const key = generateKeypair()
await db.insert(reservedKeys).values({
  did,
  signingKeyPriv: key.privateKeyHex,
  signingKeyPub: key.publicKeyMultibase,
}).onConflictDoUpdate(...)
return { signingKey: key.publicKeyMultibase }
```

`onConflictDoUpdate` means re-running the dance overwrites an older
reservation. The orphaned private key from the previous attempt is
harmless — it was never linked to a real account, and nothing else
references it.

### `com.atproto.repo.importRepo`

Code: `src/pds/xrpc/handlers/com.atproto.repo.importRepo.ts`.

POST, requires access auth. Body: a CAR file (binary). No JSON envelope.

The flow:

1. **Refuse to import into a non-empty repo.** A fresh-from-createAccount
   genesis has zero rows in `records`. Anything else and we throw
   `RepoNotEmpty` — re-importing on top of existing records would either
   orphan their blocks or silently drop them.
2. **Stream-decode the CAR.** `decodeCarChunks` from chapter 08 verifies
   every block's hash against its declared CID as it parses. By the time
   we've read the whole stream, every block in the map is *already*
   content-verified.
3. **Find the root and decode it as a `SignedCommit`.** The CAR header
   names a single root; the corresponding block has to decode to a v3
   signed commit whose `did` field matches the calling account.
4. **Verify the commit signature.** Against `accounts.signing_key_pub` —
   which, for a migration, is the public half of the key the destination
   reserved earlier. If the signature doesn't verify, throw
   `InvalidRequest`. This is the load-bearing check: we trust the bytes
   we just got because the signature over them ties them to a key only
   this PDS holds the private half of.
5. **Persist every block.** `putBlocks` writes them all into
   `repo_blocks`, idempotent via `ON CONFLICT DO NOTHING`.
6. **Rewrite the repo head.** `UPDATE repos SET root_cid = ?, rev = ?`
   to the imported values.
7. **Rebuild the records index.** Walk the imported MST with `MST.list`
   and INSERT every `(collection, rkey, cid)` triple. The MST is the
   authoritative store; this table is the read cache that chapter 14
   added.
8. **Rebuild record_blobs.** While we're decoding each record value to
   walk the MST, harvest its blob refs with `extractBlobCids` and INSERT
   them too. This is what makes `listMissingBlobs` work — without these
   rows we'd think every blob was already present.
9. **Flip migration_state.** Set the account's migration state to
   `migrating-in`.
10. **Emit a `#commit` firehose event.** Re-encode the CAR from the
    deduped block set (so consumers see exactly the bytes `getRepo`
    would hand them on this PDS) and emit. Every leaf in the imported
    MST shows up as a `create` op.

Errors:

- `InvalidCar` — malformed CAR, missing root, missing root block.
- `InvalidRequest` — the root isn't a valid commit, or the commit's DID
  doesn't match the caller, or the signature doesn't verify.
- `RepoNotEmpty` — destination already has records.

### `com.atproto.sync.listMissingBlobs`

Code: `src/pds/xrpc/handlers/com.atproto.sync.listMissingBlobs.ts`.

GET, requires access auth. Query: `?limit=500&cursor=<cid>`.

Output: `{ cursor?, blobs: [{ cid, recordUri }] }`.

The query is a LEFT JOIN: every row in `record_blobs` for the caller's
DID, joined to `blobs` on `cid`. Rows where `blobs.cid IS NULL` are the
missing ones. Pagination is by `blob_cid`; the same blob may appear in
multiple record_blobs rows (one record might use it twice via embed
unions), but the user only has to upload it once, so a tiny amount of
client-side dedup is fine.

## Receiving a migrating account

`createAccount` now branches on `input.did`. When the caller passes one,
the orchestrator drops into a second path implemented alongside the
fresh-account one in `src/pds/account/create.ts`:

```ts
if (input.did !== undefined) {
  return createMigratingAccount(input, input.did)
}
```

The migrating branch does:

1. **Reject non-`did:plc`.** Today we only migrate did:plc identifiers;
   did:web migration would skip the PLC log entirely and is left as a
   future exercise. The handler's zod schema enforces this with a
   `^did:plc:[a-z2-7]{24}$` regex so malformed input never reaches the
   orchestrator.
2. **Reject existing accounts.** `SELECT did FROM accounts WHERE did=?`
   guards against the user (or a racer) double-migrating. Surfaces as
   `AccountAlreadyExists`.
3. **Pull the reservation.** `SELECT * FROM reserved_keys WHERE did=?`.
   Absent → `MissingReservedKey` (the user skipped step 2 of the
   choreography). The row contains the keypair we generated earlier;
   the public half is what the user should have put in their PLC op.
4. **Validate the PLC op.** The op must be a `plc_operation` with a
   non-empty `sig`, a *non-null* `prev` (it's a rotate, not a genesis),
   non-empty `rotationKeys`, a `verificationMethods.atproto` that equals
   `did:key:<reserved.signingKeyPub>` (`MismatchedSigningKey`), and a
   `services.atproto_pds.endpoint` that equals our `publicUrl`
   (`MismatchedServiceEndpoint`). `alsoKnownAs[0]` must be
   `at://<input.handle>`. Anything else flunks with `IncompatibleDidDoc`.
5. **Skip signature verification.** Documented below. We trust the
   structural binding to the reserved key in local-PLC mode.
6. **Hash the password** and **DAG-CBOR encode the op** outside the
   transactional window so async work that can throw doesn't leave half
   a row behind.
7. **INSERT the account row** with `status='deactivated'`,
   `migration_state='migrating-in'`, and the reserved signing key on
   the row. The rotation-key columns are stored as empty strings —
   migrations leave the rotation key with the user, and the destination
   has no business holding one.
8. **INSERT the PLC op** at `seq=0`. We don't reconstruct the upstream
   chain locally; the migrating-in account's local PLC log starts here.
   A future `PDS_LOCAL_PLC=false` mode would publish to plc.directory
   instead.
9. **DELETE the reservation row.** The keypair lives on the account row
   now.
10. **Emit firehose events.** `#identity` with the handle binding, then
    `#account { active: false, status: 'deactivated' }` so consumers
    know the DID landed but the repo hasn't.
11. **Issue session tokens.** The user uses these to call `importRepo`
    next. No genesis repo is created — `importRepo` is the one that
    populates `repos` + `repo_blocks`.

The return shape is identical to the fresh-account path: `{ did, handle,
accessJwt, refreshJwt, didDoc }`. The `didDoc` we return is rendered
locally from the reserved signing key and our `publicUrl` — it matches
what `plc.directory` would now serve given the rotate op the user just
published upstream.

### What about the PLC signature?

We **don't** verify `plcOp.sig` against the previous op's rotation key.
A proper verification path looks like:

```
prev_op = plc.directory.resolve(did, plcOp.prev)
verify(prev_op.rotationKeys[i], canonical_bytes(plcOp - sig), plcOp.sig)
```

Both pieces are absent in local-PLC mode: there's no plc.directory
client wired up, and the upstream PDS doesn't ship its `plc_operations`
rows to the destination. We catch the wrong-key cases that *do* matter
to this PDS through the structural checks above — if `plcOp` doesn't
list our reserved key under `verificationMethods.atproto`, the imported
commits won't verify against `accounts.signing_key_pub` in `importRepo`
and the migration falls over with `InvalidRequest`. That's a different
guarantee than upstream PLC's (signature chains back to a valid prior
rotation key) but it's the load-bearing one for *this* PDS: the only
key that can sign repo writes is the one we generated and gave to the
user to put in the op.

A future chapter that flips `PDS_LOCAL_PLC=false` adds the
plc.directory verification at the same point.

## The gaps

This chapter ships four endpoints, the destination-side `createAccount`
branch, the schema groundwork, and the firehose hook. It deliberately
leaves two things unsolved.

### 1. PLC rotation is local-only

The choreography's step 4 says "publish the rotate op." In our local-PLC
mode, that means appending to `plc_operations`. But `plc_operations`
exists *per PDS*. If Alice's old PDS has her log and the new PDS
appends a rotate op locally, the two PDSes disagree about her DID
document — the firehose consumers attached to each side see different
verificationMethods.

In production this works because there's one global plc.directory and
both PDSes write to it. In local-PLC mode the gap is "no shared log."
Fixing it means flipping `PDS_LOCAL_PLC=false` and pointing at the real
directory; chapter 18 covers the env switch. The local-only PLC was
always a dev shortcut; migration is the workload that exposes its limit.

### 2. `getServiceAuth` uses HS256 instead of ES256K

Covered above. The shape of the token is right; the signing algorithm
isn't. The receiver of an HS256 token has to share the secret with the
issuer, which works when the source and destination are the same PDS
(useful for testing) and breaks across the network. The fix is one
helper that signs with the user's k256 signing key, plus a
matching verifier in the middleware that resolves the issuer's DID
document and verifies against the listed `verificationMethod[#atproto]`.

## Failure recovery

Two scenarios that come up in practice:

**`importRepo` partially succeeds.** The handler persists blocks, then
updates the repo head, then rebuilds indexes, then emits the firehose
event. Postgres is the source of truth: if we crash mid-way through
index rebuilding, the records table is partly populated but the MST is
already in `repo_blocks` and the repo head points at the imported
commit. Re-running `importRepo` would currently throw `RepoNotEmpty`
because some records rows exist. The recovery path is to DELETE from
`records` and `record_blobs` for the affected DID and re-run; a future
chapter wraps the whole thing in a transaction and reverses the
`RepoNotEmpty` rule to "non-empty *and* not in `migrating-in` state."

**`listMissingBlobs` returns thousands of entries.** Heavy accounts can
reference tens of thousands of blobs across years of post embeds. The
endpoint paginates by `cursor`, but the client still has to download
and re-upload every blob — the upload is bounded by the source PDS's
network and the client's bandwidth. A reasonable client strategy is to
process the list in parallel batches of ~10 simultaneous transfers and
re-poll `listMissingBlobs` after each batch (the page may shrink in
unexpected places as concurrent uploads complete).

## Try it (one-PDS double-act)

Without two PDSes running we can still exercise the full migration
surface by playing both sides on one process. The PDS is at
`localhost:3000`, you've created `alice.test`, and you've written a few
records to her repo. The goal is to migrate Alice's DID — same DID,
same followers — to a fresh row with handle `alice-moved.test` on the
same PDS. (In a real two-PDS setup the handle would stay the same; we
rename here because both accounts share one `accounts` table and the
handle column is unique.)

The choreography normally lives in the user's client. We'll script it
inline with `pnpm tsx`. Save the helper below as `/tmp/migrate.ts`:

```ts
// /tmp/migrate.ts — one-shot client for the migrating-in choreography.
import { db } from '~/lib/db'
import { accounts, plcOperations } from '~/lib/db/schema'
import { decode, encode } from '~/pds/codec'
import { signBytes } from '~/pds/repo/keys'
import { eq, desc } from 'drizzle-orm'

const [, , aliceDid, newHandle, reservedKeyMultibase] = process.argv
if (!aliceDid || !newHandle || !reservedKeyMultibase) {
  console.error('usage: migrate.ts <aliceDid> <newHandle> <reservedKey>')
  process.exit(1)
}

// 1. Pull Alice's rotation key + previous op out of Postgres. In a real
//    migration the rotation key lives in the user's wallet; we cheat here
//    because the fresh-account path generated it for us.
const [acc] = await db
  .select({ rotationKeyPriv: accounts.rotationKeyPriv })
  .from(accounts)
  .where(eq(accounts.did, aliceDid))
  .limit(1)
if (!acc) throw new Error('account not found')

const [prevOp] = await db
  .select({ cid: plcOperations.cid })
  .from(plcOperations)
  .where(eq(plcOperations.did, aliceDid))
  .orderBy(desc(plcOperations.seq))
  .limit(1)
if (!prevOp) throw new Error('no prior PLC op')

// 2. Re-derive Alice's *current* rotation did:key so we can echo it back.
const prevBytes = (
  await db
    .select({ op: plcOperations.operation })
    .from(plcOperations)
    .where(eq(plcOperations.did, aliceDid))
    .orderBy(desc(plcOperations.seq))
    .limit(1)
)[0]!.op
const prev = await decode<{ rotationKeys: string[] }>(prevBytes)

// 3. Build + sign the rotate op.
const unsigned = {
  type: 'plc_operation' as const,
  rotationKeys: prev.rotationKeys,
  verificationMethods: { atproto: 'did:key:' + reservedKeyMultibase },
  alsoKnownAs: [`at://${newHandle}`],
  services: {
    atproto_pds: {
      type: 'AtprotoPersonalDataServer',
      endpoint: 'http://localhost:3000',
    },
  },
  prev: prevOp.cid,
}
const block = await encode(unsigned)
const sig = signBytes(acc.rotationKeyPriv, block.bytes)
const b64 = Buffer.from(sig)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
console.log(JSON.stringify({ ...unsigned, sig: b64 }))
```

Then drive the flow:

```bash
# 0. Log in as Alice, grab a service token, snapshot her DID.
ALICE_JWT=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"alice.test","password":"correcthorsebatterystaple"}' \
  | jq -r .accessJwt)
ALICE_DID=$(curl -s http://localhost:3000/xrpc/com.atproto.server.getSession \
  -H "Authorization: Bearer $ALICE_JWT" | jq -r .did)
SERVICE_TOKEN=$(curl -s \
  "http://localhost:3000/xrpc/com.atproto.server.getServiceAuth?aud=did:web:localhost&lxm=com.atproto.sync.getRepo" \
  -H "Authorization: Bearer $ALICE_JWT" | jq -r .token)

# 1. Reserve a signing key on the destination for Alice's DID.
RESERVED_KEY=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.reserveSigningKey \
  -H 'content-type: application/json' \
  -d "{\"did\":\"$ALICE_DID\"}" | jq -r .signingKey)

# 2. Build + sign the PLC rotate op with the helper.
PLC_OP=$(pnpm --silent tsx /tmp/migrate.ts "$ALICE_DID" alice-moved.test "$RESERVED_KEY")

# 3. Download Alice's repo from the "source".
curl -s "http://localhost:3000/xrpc/com.atproto.sync.getRepo?did=$ALICE_DID" \
  -H "Authorization: Bearer $SERVICE_TOKEN" -o /tmp/alice.car

# 4. Tear down Alice's source row so the destination INSERT can land
#    (one-process limitation: the DID is a primary key).
pnpm --silent tsx -e "
  import('~/lib/db').then(async ({ db }) => {
    const { accounts } = await import('~/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(accounts).where(eq(accounts.did, '$ALICE_DID'))
  })
"

# 5. Create the destination account with Alice's DID + signed op.
DEST=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d "{
    \"handle\": \"alice-moved.test\",
    \"email\": \"alice+moved@example.com\",
    \"password\": \"correcthorsebatterystaple\",
    \"did\": \"$ALICE_DID\",
    \"plcOp\": $PLC_OP
  }")
DEST_JWT=$(echo "$DEST" | jq -r .accessJwt)

# 6. Import the CAR.
curl -s -X POST http://localhost:3000/xrpc/com.atproto.repo.importRepo \
  -H "Authorization: Bearer $DEST_JWT" \
  -H 'content-type: application/vnd.ipld.car' \
  --data-binary @/tmp/alice.car

# 7. Listed missing blobs (empty for the simple case).
curl -s http://localhost:3000/xrpc/com.atproto.sync.listMissingBlobs \
  -H "Authorization: Bearer $DEST_JWT" | jq

# 8. Activate.
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.activateAccount \
  -H "Authorization: Bearer $DEST_JWT"
```

After step 8, `accounts.status` is `active` and `migration_state`
remains `migrating-in` so downstream consumers know this account
landed via migration rather than fresh signup. The firehose has
emitted, in order: `#identity`, `#account { active: false,
status: 'deactivated' }`, `#commit` (the imported tree), and
`#account { active: true }`.

> 📖 **One-process shortcuts.** Step 4 deletes the source row because
> our DB collapses the two-PDS topology to one table. In a real
> migration the source PDS keeps the row and later flips its
> `migration_state` to `migrating-out` (gap 3 in the original list).
> Step 2 pulls the rotation key out of Postgres because the
> fresh-account flow generated it server-side; in a real migration the
> rotation key lives in the user's client and never leaves it.

## Exercises

1. Add an `lxm`-validation hook to the access middleware: when an XRPC
   request presents a service token (issuer ≠ audience), check that the
   token's `lxm` claim matches the NSID being called. What should the
   error name be on mismatch? Where in `dispatch` does the check belong
   — before or after the handler's own auth call?

2. The pagination cursor on `listMissingBlobs` is the last `blob_cid`
   from the page. What goes wrong if two different `record_uri` rows
   reference the same blob CID and that CID is the page boundary? Sketch
   the fix that uses a composite `(blob_cid, record_uri)` cursor without
   changing the response shape.

3. Sketch the source-side `requestAccountMigrate` endpoint that
   complements the destination's `importRepo`. It needs to mark
   `migration_state = 'migrating-out'`, emit some firehose event the
   consumers can use to drop their local index of the account, and
   accept proof that the destination has actually received the repo
   (what's the proof?). Where does it sit in the choreography above?

← [19 — Moderation](./19-moderation.md) ·
[Table of contents](./README.md)
