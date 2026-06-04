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
- `com.atproto.server.getServiceAuth` — mints a short-lived JWT the
  destination PDS can present when it pulls the repo. 60-second cap;
  used for one-shot fetches.
- `com.atproto.server.requestAccountMigrate` — *new* in this wave. The
  user's "I'm leaving" handshake. Flips `migration_state` to
  `'migrating-out'`, mints a *one-hour* service token the user carries
  to the destination PDS to authorise the full ingest, and emits an
  `#account { active: false }` so subscribers stop accepting writes.
- `com.atproto.identity.requestPlcOperationSignature` +
  `com.atproto.identity.signPlcOperation` — *new* in this wave. The
  user-facing path for self-custody PLC ops. Together they let the user
  drive a key/service rotation that updateHandle can't express on its
  own — which is exactly what migration needs (swap the signing key to
  the destination's reserved one, swap the service endpoint to the
  destination's URL).

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
- `com.atproto.repo.listMissingBlobs` — new. Reports the blob CIDs the
  imported records reference but the destination blob store doesn't have
  bytes for yet.
- `com.atproto.repo.uploadBlob` — chapter 15. The user POSTs each missing
  blob in turn.
- `com.atproto.identity.getRecommendedDidCredentials` — new. The
  destination's "if you rotated your DID to point here, here's exactly
  what it should say" payload. Consumed by `signPlcOperation` on the
  source side to construct a rotation op.
- `com.atproto.identity.submitPlcOperation` — new. Destination accepts
  the signed rotation op, validates it points at this PDS, and POSTs
  to plc.directory.
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
2. **Ask the old PDS for its leaving handshake.**
   `POST /xrpc/com.atproto.server.requestAccountMigrate { "to": "https://dest.example" }`.
   The old PDS fetches `https://dest.example/.well-known/did.json` to
   pin the destination's service DID, flips
   `accounts.migration_state` to `'migrating-out'`, emits
   `#account { active: false, status: 'deactivated' }` on the
   firehose, and returns `{ token, destination }` where `token` is a
   one-hour service JWT scoped to the destination DID. Alice carries
   the token to the new PDS.
3. **Reserve a signing key on the new PDS.**
   `POST /xrpc/com.atproto.server.reserveSigningKey { "did": "did:plc:alice..." }`.
   The new PDS generates a fresh k256 keypair, stores the private half in
   `reserved_keys`, and returns the Multikey-encoded public half:
   `{ "signingKey": "z6Mk..." }`.
4. **Mint the PLC-signature email token on the old PDS.**
   `POST /xrpc/com.atproto.identity.requestPlcOperationSignature` (no body).
   The old PDS emails a 32-character base32 token to the address on
   file. The 15-minute TTL is the lower bound for "trust the user has
   physical access to that inbox" — the email round-trip is the slow
   path that distinguishes a PLC op from an ordinary handle change.
5. **Sign the rotate op on the old PDS.**
   `POST /xrpc/com.atproto.identity.signPlcOperation` with
   `{ token, verificationMethods: { atproto: "did:key:<reserved>" },
   services: { atproto_pds: { type: "AtprotoPersonalDataServer",
   endpoint: "https://dest.example" } } }`. The old PDS consumes the
   token, loads the previous PLC op for forwarding-untouched-fields,
   signs the new op with Alice's server-held rotation key, appends it
   to `plc_operations`, publishes upstream (no-op in local mode),
   emits `#identity`, and returns `{ operation: <signedOp> }`. The
   signed op carries `prev`-pointing back at the genesis (or whichever
   op was most recent) and is what plc.directory now serves as Alice's
   DID document.
6. **Create the destination account.** `POST /xrpc/com.atproto.server.createAccount`
   with Alice's existing DID and the signed plcOp from step 5. The
   destination validates the op (the `atproto` verification method must
   match the key we just reserved; the service endpoint must match our
   `publicUrl`; the handle in `alsoKnownAs[0]` must match the request),
   persists it as the local PLC genesis (seq 0 — the upstream chain
   stays on the old PDS), consumes the reservation, inserts the account
   row with `status='deactivated'` and `migration_state='migrating-in'`,
   and hands back a session.
7. **Download the source repo as a CAR.** `GET /xrpc/com.atproto.sync.getRepo?did=...`,
   carrying the token from step 2 as `Authorization: Bearer ...`. The
   response is a CAR of every block reachable from the current commit.
   (The one-hour TTL is what lets the same token cover both this
   getRepo and the listMissingBlobs / getBlob loop below; the 60-second
   `getServiceAuth` token would have to be re-minted before each call.)
8. **Import the CAR into the destination.** `POST /xrpc/com.atproto.repo.importRepo`
   with the CAR as the binary body and the new account's session as auth.
   The destination verifies the commit signature against the reserved
   signing key, persists every block, rebuilds the records + record_blobs
   indexes, and emits a `#commit` firehose event.
9. **Reconcile blobs.** `GET /xrpc/com.atproto.repo.listMissingBlobs`. For
   each `{ cid, recordUri }` it returns, Alice's client downloads the
   blob from the source PDS (`com.atproto.sync.getBlob`, presenting the
   step-2 token) and uploads it to the destination
   (`com.atproto.repo.uploadBlob`). Loop until the list is empty
   (paginate with `cursor`).
10. **Activate.** `POST /xrpc/com.atproto.server.activateAccount` on the
    destination. The account flips from `deactivated` to `active`; the
    firehose announces `#account { active: true }`.

That's the protocol. Three new POSTs that landed in this wave
(`requestAccountMigrate`, `requestPlcOperationSignature`,
`signPlcOperation`) plus the destination-side bundle from earlier
(`reserveSigningKey`, `importRepo`, `listMissingBlobs`), the existing
read paths, and one rotate op against the PLC — signed by *this* PDS
because the rotation key never leaves the server.

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

## Source-side: `requestAccountMigrate`

Code: `src/pds/xrpc/handlers/com.atproto.server.requestAccountMigrate.ts`.

POST, requires `transition:generic` (the broad write scope). Input:
`{ to: string }` — the destination PDS's *public URL*, not its DID.
The handler does the resolution.

The handler's path is short:

1. **Validate `to`** as a parseable URL. HTTPS is required unless this
   PDS itself runs on localhost (the dev policy carried over from
   `createAccount`'s endpoint check).
2. **Fetch `<to>/.well-known/did.json`** and pluck out the
   `AtprotoPersonalDataServer` service entry. The destination's
   self-described `id` (a `did:web:...` typically) is what we put in
   the token's `aud`. Any malformed doc — no `service` array, no
   AtprotoPersonalDataServer entry, non-JSON response, network failure
   — surfaces as `BadDestination` (400). The user is asking us to
   migrate to a host that doesn't speak the protocol.
3. **Flip `accounts.migration_state` to `'migrating-out'`.** Status
   stays whatever it was; the user can still log in, fetch their repo,
   etc. The firehose marker is what tells the *world* that writes from
   this DID should stop being trusted.
4. **Mint a one-hour service token.** `signServiceToken` normally caps
   at 60s; we pass the explicit `unsafeLongLived: true` opt-in to
   stretch to 60 minutes. `lxm` is intentionally absent — the
   destination uses this single token for `sync.getRepo` *plus* the
   `sync.getBlob` / `repo.listMissingBlobs` reconciliation loop, so
   pinning it to one method would force a re-mint every step.
5. **Emit `#account { active: false, status: 'deactivated' }`.** Best-effort:
   a sequencer outage shouldn't unwind the migration_state flip. The
   consumer recovers on its next reconnect.

Output:

```ts
{
  token: string,              // 1-hour service JWT; aud = destination.did
  destination: {
    did: string,              // from did.json#id
    endpoint: string,         // from the AtprotoPersonalDataServer entry
  }
}
```

> ⚠️ The 60-second cap on `signServiceToken` exists for a reason — a
> leaked service token has its full TTL of blast radius. The
> `unsafeLongLived` opt-in is named that way to keep the trade-off
> visible. The migration flow needs it because the destination drives a
> multi-step ingest (getRepo, then loop over getBlob); minting fresh
> 60-second tokens after each call would require keeping a session live
> on the source PDS for the whole migration, which is exactly the
> property the user is trying to give up.

The `migration_state` flip is durable. We don't have a callback for
"the destination is done"; the source stays in `'migrating-out'` until
an operator runs the (not-yet-built) `accountMigrated` admin action.
That's the next gap to close — there's a future chapter about
operator-driven account lifecycle that owns it.

## Self-custody PLC ops: `requestPlcOperationSignature` + `signPlcOperation`

Code: `src/pds/xrpc/handlers/com.atproto.identity.requestPlcOperationSignature.ts`
and `com.atproto.identity.signPlcOperation.ts`.

The two-step "user-driven PLC op" surface. Together they unlock the
*signing key rotation* and *service endpoint change* listed in
chapter 04 as future rotation kinds — `updateHandle` can only flip
`alsoKnownAs`, but a real migration has to flip
`verificationMethods.atproto` and `services.atproto_pds.endpoint`
simultaneously.

### `requestPlcOperationSignature`

POST, `transition:generic`, no input. Issues an `email_tokens` row with
purpose `'plc-operation-signature'` and a 15-minute TTL, then emails
the token to the address on file. Returns `{}`.

Why an email round-trip when the user already has a session? Because
the op the token unlocks rewrites the DID document — *every* field,
including the rotation keyset itself. We want a slow, traceable proof
that the request came from the human who controls the inbox, not just
the session. 15 minutes is enough for inbox latency and tight enough
that a compromised session has a narrow window to exploit a token
they didn't expect.

### `signPlcOperation`

POST, `transition:generic`. Input:

```ts
{
  token: string,                          // from requestPlcOperationSignature
  rotationKeys?: string[],                // optional override
  alsoKnownAs?: string[],                 // ditto
  verificationMethods?: Record<string,string>,
  services?: Record<string, {type: string, endpoint: string}>,
}
```

Any field that's omitted is carried forward from the latest op — the
same overlay-on-latest pattern `rotatePlc` uses for handle changes,
generalised to expose every field of `UnsignedPlcOp`. The handler:

1. **Consumes the email token.** `consumeEmailToken` throws
   `Unauthorized InvalidToken` on miss; the lexicon's documented error.
2. **Loads the latest PLC op** (newly-exported `loadLatestPlcOp`).
3. **Overlays caller fields** on the latest op's fields. `prev` is
   always the latest op's CID.
4. **Signs with the user's server-held rotation key.** The signing
   algorithm is the same secp256k1 / DAG-CBOR pipeline as
   `buildGenesisPlc` and `rotatePlc`.
5. **Persists at `seq = previous + 1`** in `plc_operations`.
6. **Publishes upstream.** No-op in local-PLC mode; in production this
   POSTs to plc.directory and the new doc becomes globally visible.
7. **If `alsoKnownAs` changed**, atomically updates `accounts.handle`
   to match `alsoKnownAs[0]` (without the `at://` prefix).
8. **Emits `#identity`** so firehose consumers re-resolve.

Output: `{ operation: <signedOp> }` — the same DAG-CBOR JSON the user
would otherwise carry off to plc.directory themselves.

> ⚠️ **Upstream divergence: rotation-key safety check.** The reference
> Bluesky PDS refuses to sign an op that drops *its own* rotation key
> out of `rotationKeys` — doing so would lock the PDS out of
> authorising any future rotation. We **log a warning** but don't
> refuse, because migration intentionally walks that edge: when Alice
> moves to a new PDS, the rotation key stays with her (or with the new
> PDS), not the old one. A hard refusal would block the very flow this
> chapter unlocks. The tightening to a *conditional* refusal — accept
> the drop only when accompanied by a `migrating-out` migration_state
> flip — is a follow-up.



Code: `src/pds/xrpc/handlers/com.atproto.server.getServiceAuth.ts`.

GET, requires the caller's access token. Query parameters:

- `aud` (required) — the target service DID.
- `lxm` (optional) — the lexicon method NSID this token authorizes.
- `exp` (optional) — desired expiry as unix-seconds. Capped at 60 seconds
  out.

Output: `{ token: "<jwt>" }`.

We sign ES256K with the account's k256 repo signing key — the same key
listed as `#atproto` in the user's DID document. The claims:

```
iss = <user DID>
aud = <target service DID>
lxm = <method NSID>     (if provided)
iat = <now>
exp = <now + ttl>
jti = <random base64url>
```

The receiver (bsky.app, the Relay, the destination PDS) verifies the
signature against the `verificationMethod[#atproto]` entry in the
issuer's DID document. No shared secret crosses the wire; the token is
content-addressed by the same key that signs the user's repo, so a
counterfeit would have to compromise the signing key itself. The signer
lives in `src/pds/auth/service_auth.ts` and is reused by
`requestAccountMigrate` to mint the longer-lived (one-hour) token the
destination PDS presents to the source.

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

### `com.atproto.identity.getRecommendedDidCredentials`

Code: `src/pds/xrpc/handlers/com.atproto.identity.getRecommendedDidCredentials.ts`.

GET, requires access auth. No params.

Output:

```json
{
  "alsoKnownAs": ["at://<handle>"],
  "verificationMethods": { "atproto": "<signing key did:key>" },
  "rotationKeys": ["<rotation key did:key>"],
  "services": {
    "atproto_pds": {
      "type": "AtprotoPersonalDataServer",
      "endpoint": "https://<this-pds>"
    }
  }
}
```

"If you were going to rotate your DID document to point at *this* PDS,
here's exactly what it should say." The migrating user calls this on
the destination after `createAccount` lands their account row, then
hands the payload to `signPlcOperation` (typically on the old PDS,
which still holds the rotation key) to construct the rotation op.

We read the verification + rotation keys straight off `accounts` —
they were generated at signup (or supplied during the migrating-in
`createAccount` path) and are durable for the life of the account.
`alsoKnownAs` is `at://<current handle>`. `services.atproto_pds.endpoint`
is whatever `PDS_PUBLIC_URL` says today, so a rebrand-by-CNAME on the
PDS side flows through correctly.

### `com.atproto.identity.submitPlcOperation`

Code: `src/pds/xrpc/handlers/com.atproto.identity.submitPlcOperation.ts`.

POST, requires access auth. Body: `{ operation: <signed PLC op> }`.

The caller hands in a *signed* op (built by `signPlcOperation`
elsewhere — typically on the source PDS, while they still hold the
rotation key). This endpoint validates that the op correctly points at
us, persists it to `plc_operations`, POSTs it to plc.directory, and
emits `#identity` on the firehose. After the directory accepts, the
world starts resolving the DID to this PDS.

We're strict about what the op may contain. All of these have to
match exactly, or we reject with `InvalidRequest`:

- `rotationKeys` must include the rotation key from `accounts`
- `services.atproto_pds.type` must be `AtprotoPersonalDataServer`
- `services.atproto_pds.endpoint` must equal `getConfig().publicUrl`
- `verificationMethods.atproto` must equal the signing key from `accounts`
- `alsoKnownAs[0]` must be `at://<accounts.handle>`

The error strings match the reference PDS's so a Bluesky client gets
the familiar message. The strictness is on purpose: a user who pushes
an op that points at a *different* PDS would brick the migration —
plc.directory would accept it, our local DID resolver would still say
"yes that's us" until cache TTL, and the firehose `#identity` event
would contradict reality.

Local-PLC mode (`PDS_LOCAL_PLC=true`, the dev default) skips the
plc.directory POST — `publishPlcOp` returns immediately. The local
row in `plc_operations` is still written so a same-PDS double-act
test can drive the full flow without an external directory.

### `com.atproto.repo.listMissingBlobs`

Code: `src/pds/xrpc/handlers/com.atproto.repo.listMissingBlobs.ts`.

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

This wave promotes `signPlcOperation` + `requestPlcOperationSignature`
out of stub state, adds `requestAccountMigrate`, and extends the
choreography to cover the source side end-to-end. Three gaps remain.

### 1. PLC rotation is local-only

The choreography says "publish the rotate op." In our local-PLC mode
`signPlcOperation` appends to `plc_operations` and `publishPlcOp` is a
no-op. But `plc_operations` exists *per PDS*. If Alice's old PDS has
her log and the new PDS appends a separate rotate op locally, the two
PDSes disagree about her DID document — the firehose consumers
attached to each side see different verificationMethods.

In production this works because there's one global plc.directory and
both PDSes write to it. In local-PLC mode the gap is "no shared log."
Fixing it means flipping `PDS_LOCAL_PLC=false` and pointing at the
real directory; chapter 18 covers the env switch. The local-only PLC
was always a dev shortcut; migration is the workload that exposes its
limit.

### 2. No `accountMigrated` cleanup on the source

After `requestAccountMigrate` runs, `migration_state` stays
`'migrating-out'` forever — there's no callback from the destination
saying "we have the repo, you can stop holding it." A future
`accountMigrated` admin action would mark the source row as
`migrated-out` (or simply tombstone it), free the disk, and emit a
final `#tombstone` so firehose consumers can drop the DID from their
indexes. We don't ship it here; the moderation-adjacent chapter that
owns operator-driven account lifecycle is the natural home.

### 3. `signPlcOperation` doesn't refuse self-eviction

The handler logs a warning but accepts an op that drops this PDS's
rotation key out of `rotationKeys`. The reference Bluesky PDS refuses
outright. Tightening to a *conditional* refusal — accept the drop only
when `migration_state = 'migrating-out'` — keeps the migration flow
working while restoring the safety property for everyone else. Listed
as an exercise below.

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

Every step below is a real XRPC call — no fixture helpers, no
poking at the database from a script. The only place we cheat is
step 5, where we read the PLC-signature email token out of
`email_tokens` instead of waiting for SMTP; the dev `sendEmail`
already logs it to the console, but reading the DB keeps the script
self-contained.

```bash
# 0. Log in as Alice and snapshot her DID.
ALICE_JWT=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"alice.test","password":"correcthorsebatterystaple"}' \
  | jq -r .accessJwt)
ALICE_DID=$(curl -s http://localhost:3000/xrpc/com.atproto.server.getSession \
  -H "Authorization: Bearer $ALICE_JWT" | jq -r .did)

# 1. (Source) Ask the old PDS for the leaving handshake. Returns a
#    one-hour service token + the destination's service DID/endpoint.
MIGRATE=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.requestAccountMigrate \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $ALICE_JWT" \
  -d '{"to": "http://localhost:3000"}')
SERVICE_TOKEN=$(echo "$MIGRATE" | jq -r .token)
DEST_DID=$(echo "$MIGRATE" | jq -r .destination.did)

# 2. (Destination) Reserve a signing key on the new PDS for Alice's DID.
RESERVED_KEY=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.reserveSigningKey \
  -H 'content-type: application/json' \
  -d "{\"did\":\"$ALICE_DID\"}" | jq -r .signingKey)

# 3. (Source) Ask for a PLC-signature token. The token will be in the
#    server's stdout via the dev sendEmail; we read it from the DB.
curl -s -X POST http://localhost:3000/xrpc/com.atproto.identity.requestPlcOperationSignature \
  -H "Authorization: Bearer $ALICE_JWT"
PLC_TOKEN=$(pnpm --silent tsx -e "
  import('~/lib/db').then(async ({ db }) => {
    const { emailTokens } = await import('~/lib/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const r = await db.select().from(emailTokens).where(and(
      eq(emailTokens.did, '$ALICE_DID'),
      eq(emailTokens.purpose, 'plc-operation-signature'),
    ))
    process.stdout.write(r[0].token)
  })
")

# 4. (Source) Sign the rotate op on the old PDS. The new
#    verificationMethods.atproto points at the reserved key; the new
#    services.atproto_pds.endpoint points at the destination URL. The
#    handle changes too (one-process workaround for the unique-handle
#    constraint). The handler signs with Alice's server-held rotation
#    key, appends to plc_operations, emits #identity, and returns the
#    signed op.
SIGNED=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.identity.signPlcOperation \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $ALICE_JWT" \
  -d "{
    \"token\": \"$PLC_TOKEN\",
    \"alsoKnownAs\": [\"at://alice-moved.test\"],
    \"verificationMethods\": {\"atproto\": \"did:key:$RESERVED_KEY\"},
    \"services\": {\"atproto_pds\": {\"type\":\"AtprotoPersonalDataServer\",\"endpoint\":\"http://localhost:3000\"}}
  }")
PLC_OP=$(echo "$SIGNED" | jq -c .operation)

# 5. (Source) Download Alice's repo using the migration service token.
curl -s "http://localhost:3000/xrpc/com.atproto.sync.getRepo?did=$ALICE_DID" \
  -H "Authorization: Bearer $SERVICE_TOKEN" -o /tmp/alice.car

# 6. (Source) One-process workaround: drop the source account row so the
#    destination INSERT can land. In a real two-PDS setup the source
#    row would persist with migration_state='migrating-out' until the
#    operator-driven accountMigrated action cleans it up (gap 3).
pnpm --silent tsx -e "
  import('~/lib/db').then(async ({ db }) => {
    const { accounts } = await import('~/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(accounts).where(eq(accounts.did, '$ALICE_DID'))
  })
"

# 7. (Destination) Create the destination account with Alice's DID +
#    signed op.
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

# 8. (Destination) Import the CAR.
curl -s -X POST http://localhost:3000/xrpc/com.atproto.repo.importRepo \
  -H "Authorization: Bearer $DEST_JWT" \
  -H 'content-type: application/vnd.ipld.car' \
  --data-binary @/tmp/alice.car

# 9. (Destination) Listed missing blobs (empty for the simple case).
curl -s http://localhost:3000/xrpc/com.atproto.repo.listMissingBlobs \
  -H "Authorization: Bearer $DEST_JWT" | jq

# 10. (Destination) Activate.
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.activateAccount \
  -H "Authorization: Bearer $DEST_JWT"
```

After step 10, `accounts.status` is `active` and `migration_state`
remains `migrating-in` so downstream consumers know this account
landed via migration rather than fresh signup. The firehose has
emitted, in order: `#identity` (from `signPlcOperation`),
`#account { active: false, status: 'deactivated' }` (from
`requestAccountMigrate`), `#identity` again (from the destination's
createAccount), `#account { active: false, status: 'deactivated' }`
(destination side), `#commit` (the imported tree), and finally
`#account { active: true }`.

> 📖 **One-process shortcuts.** Step 6 deletes the source row because
> our DB collapses the two-PDS topology to one table; in real life the
> row would stick around under `migration_state='migrating-out'`. The
> rotation key signing in step 4 is what *would* normally happen on a
> client that holds the rotation key offline — we keep it server-side
> because that's the property the fresh-account flow chose. A future
> chapter on hardware-backed rotation keys would move this step
> off-server entirely.

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

3. Tighten `signPlcOperation`'s "do we still hold a rotation key after
   this op?" check from a log line to a conditional refusal: accept the
   removal only when `accounts.migration_state = 'migrating-out'`,
   otherwise throw `InvalidRequest InvalidRotationKey`. Which test
   needs updating, and what's the order between the `migration_state`
   read and the email-token consume? (Hint: a token shouldn't be burned
   on a request the handler was always going to refuse.)

4. Design the `accountMigrated` admin endpoint that closes gap 3.
   Inputs (which DID, what proof the migration completed?), state
   transitions (`migrating-out` → ?), firehose events (`#tombstone`?
   `#account { status: 'deleted' }`?), and what disk it should be free
   to delete (`repo_blocks`, `blobs`, `plc_operations`?).

← [19 — Moderation](./19-moderation.md) ·
[Table of contents](./README.md)
