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
- `com.atproto.server.createAccount` — chapter 12. **Today's
  implementation doesn't yet accept a pre-existing DID + plcOp**, so the
  destination side is not yet a full end-to-end story. We document the
  gap below.
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
   with Alice's existing DID and the signed plcOp from step 3. ⚠️ Our
   `createAccount` doesn't accept `did` or `plcOp` yet — see the gap
   below.
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

> ⚠️ **The pull-in isn't wired up.** See the gap section. Today the
> reservation is correct on the schema level and `reserveSigningKey`
> returns the right public key, but `createAccount` still generates a
> fresh key instead of consuming the reservation.

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

## The gaps

This chapter ships four endpoints, the schema groundwork, and the
firehose hook. It deliberately leaves three things unsolved.

### 1. `createAccount` doesn't accept a pre-existing DID

Step 6 of the choreography needs the destination to skip key generation
and PLC op signing, take the user-supplied DID + plcOp, and use the
reserved signing key. The orchestrator in `src/pds/account/create.ts`
currently does steps 3 and 4 unconditionally. The diff:

```ts
// Pseudo-diff against createAccount
if (input.did) {
  // Migrating in.
  const reservation = await db
    .select()
    .from(reservedKeys)
    .where(eq(reservedKeys.did, input.did))
    .limit(1)
  if (!reservation[0]) {
    throw BadRequest('no signing key reserved for ' + input.did)
  }
  signingKey = {
    privateKeyHex: reservation[0].signingKeyPriv,
    publicKeyMultibase: reservation[0].signingKeyPub,
    didKey: 'did:key:' + reservation[0].signingKeyPub,
  }
  if (!input.plcOp) throw BadRequest('plcOp required for migration')
  // Verify the plcOp's verificationMethods.atproto matches our reserved
  // signing key, then persist it as the genesis op of this DID.
  await persistPlcOp(input.did, input.plcOp)
  // Skip the empty-repo creation — importRepo will populate.
  await db.insert(accounts).values({ did: input.did, ... })
  // Account starts deactivated; activates after importRepo + blobs land.
  await db.update(accounts).set({ status: 'deactivated',
    migrationState: 'migrating-in' }).where(eq(accounts.did, input.did))
  return ...
}
```

The same orchestrator covers both cases; the migrating branch just
replaces "generate keys + PLC op" with "look up reservation + accept
plcOp." We left it as a follow-up to keep this chapter focused on the
new endpoints. The schema and the reserved-key flow are already in
place; finishing the wiring is a single file change.

### 2. PLC rotation is local-only

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

### 3. `getServiceAuth` uses HS256 instead of ES256K

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

Without two PDSes running we can still exercise most of the surface by
playing both sides on one process. The commands below assume the PDS is
up at `localhost:3000` and you've created an account `alice.test`. We'll
*pretend* to migrate her to a new account `bob.test` on the same PDS.

```bash
# 1. Log in as Alice and grab a service token.
ALICE_JWT=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H "content-type: application/json" \
  -d '{"identifier":"alice.test","password":"correcthorsebatterystaple"}' \
  | jq -r .accessJwt)

SERVICE_TOKEN=$(curl -s "http://localhost:3000/xrpc/com.atproto.server.getServiceAuth?aud=did:web:localhost&lxm=com.atproto.sync.getRepo" \
  -H "Authorization: Bearer $ALICE_JWT" | jq -r .token)
echo $SERVICE_TOKEN

# 2. Reserve a signing key for a pretend new DID.
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.reserveSigningKey \
  -H "content-type: application/json" \
  -d '{"did":"did:plc:pretend-migrating-account"}' | jq

# 3. Download Alice's repo as a CAR.
ALICE_DID=$(curl -s http://localhost:3000/xrpc/com.atproto.server.getSession \
  -H "Authorization: Bearer $ALICE_JWT" | jq -r .did)
curl -s "http://localhost:3000/xrpc/com.atproto.sync.getRepo?did=$ALICE_DID" \
  -o alice.car
ls -la alice.car

# 4. ⚠️ Skipped: createAccount with pre-existing DID. Until that lands, we
#    can't actually receive the import on a fresh account from a second
#    user session in the same process.

# 5. List missing blobs (will be empty if Alice has no records yet).
curl -s http://localhost:3000/xrpc/com.atproto.sync.listMissingBlobs \
  -H "Authorization: Bearer $ALICE_JWT" | jq
```

The full e2e (createAccount → importRepo → listMissingBlobs → uploadBlob
→ activateAccount) lights up once the createAccount follow-up lands.

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
