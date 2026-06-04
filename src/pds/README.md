# `src/pds/`

The PDS itself. Everything in this tree is server code — none of it depends
on React, the router, or the docs UI. Each subdirectory matches a chapter in
[`/docs`](../../docs/README.md) and is small enough to read top-to-bottom.

| Subsystem | Lives in | Status | Chapter |
| --- | --- | --- | --- |
| Content-addressing & IPLD | [`codec/`](./codec/) | ✅ | [05](../../docs/05-cid-and-dagcbor.md) |
| Merkle Search Trees | [`repo/mst.ts`](./repo/mst.ts) | ✅ | [06](../../docs/06-merkle-search-tree.md) |
| Commits & signing | [`repo/commit.ts`](./repo/commit.ts), [`repo/keys.ts`](./repo/keys.ts) | ✅ | [07](../../docs/07-commits-and-signing.md) |
| CAR file encoding | [`car/`](./car/) | ✅ | [08](../../docs/08-car-files.md) |
| Lexicons | [`lexicon/`](./lexicon/) | ✅ runtime validator (observe-only by default) | [09](../../docs/09-lexicons.md) |
| XRPC dispatcher + proxy | [`xrpc/`](./xrpc/) | ✅ + `Atproto-Proxy` forwarding | [10](../../docs/10-xrpc.md), [17](../../docs/17-pds-appview-relay.md) |
| DIDs & identity | [`did/`](./did/) | ✅ (local + plc.directory + did:web) | [12](../../docs/12-accounts.md) |
| Account creation | [`account/create.ts`](./account/create.ts) | ✅ | [12](../../docs/12-accounts.md) |
| Authentication | [`auth/`](./auth/) | ✅ sessions, app pws, email tokens, scrypt, KeyWrapper | [13](../../docs/13-authentication.md) |
| Record writes | [`repo/writes.ts`](./repo/writes.ts) | ✅ | [14](../../docs/14-records.md) |
| Blob storage | [`blob/`](./blob/) | ✅ (filesystem + S3 stub, GC) | [15](../../docs/15-blobs.md) |
| Event sequencer | [`sequencer/sequence.ts`](./sequencer/sequence.ts) | ✅ writer | [16](../../docs/16-firehose.md) |
| Firehose WebSocket | [`sequencer/firehose.ts`](./sequencer/) | ✅ replay + live tail | [16](../../docs/16-firehose.md) |
| Sync endpoints | [`repo/sync.ts`](./repo/sync.ts) + sync handlers | ✅ | [17](../../docs/17-pds-appview-relay.md) |
| Admin audit log | [`admin/`](./admin/) | ✅ DAG-CBOR `admin_audit` | [19](../../docs/19-moderation.md) |
| Account migration | [`account/create.ts`](./account/create.ts) (migrating-in) + migration handlers | ✅ | [20](../../docs/20-migration.md) |
| OAuth (AS + RS) | [`oauth/`](./oauth/) | ✅ PAR + PKCE + DPoP + JWKS | [21](../../docs/21-oauth.md) |
| Ozone-shaped moderation | [`mod/`](./mod/) — team, events, requireModerator | ✅ emitEvent + queries + labels surface | [24](../../docs/24-ozone-port.md) |

## XRPC endpoints

Every XRPC handler lives under [`xrpc/handlers/`](./xrpc/handlers/) as a
single file named after its NSID. The handler registry (one line per
endpoint) is in [`xrpc/handlers/index.ts`](./xrpc/handlers/index.ts).
Currently shipped (115):

```
─── com.atproto.server.* ───────────────────────────────────────
createAccount       refreshSession    requestEmailConfirmation
createSession       deleteSession     confirmEmail
describeServer      getSession        requestEmailUpdate
createInviteCode    createInviteCodes updateEmail
getAccountInviteCodes  checkSignupQueue
checkAccountStatus  deactivateAccount activateAccount
requestAccountDelete  deleteAccount
createAppPassword   listAppPasswords  revokeAppPassword
requestPasswordReset  resetPassword
─── com.atproto.server.* (migration) ───────────────────────────
getServiceAuth      reserveSigningKey   requestAccountMigrate
─── com.atproto.identity.* ─────────────────────────────────────
resolveHandle       updateHandle
requestPlcOperationSignature   signPlcOperation
─── com.atproto.repo.* ─────────────────────────────────────────
createRecord  putRecord  deleteRecord  getRecord  listRecords
applyWrites   describeRepo  uploadBlob  importRepo
─── com.atproto.sync.* (HTTP + WS) ─────────────────────────────
getRepo  getBlocks  getRecord  getLatestCommit  getRepoStatus
listRepos  getBlob  listMissingBlobs  subscribeRepos
─── com.atproto.admin.* ────────────────────────────────────────
getAccountInfo  getAccountInfos
updateAccountStatus  updateAccountHandle  updateAccountEmail
sendEmail  deleteAccount  getAuditLog
─── app.bsky.actor.* (PDS-served slice of the bsky surface) ────
getPreferences  putPreferences
```

Anything *not* in this list, when called with an `Atproto-Proxy:
<did>#<service-id>` header, is forwarded to the named upstream service
with a freshly-minted ES256K service-auth JWT signed by the caller's
repo key — see [`xrpc/proxy.ts`](./xrpc/proxy.ts) and chapter 17.
Without the header, unknown NSIDs 404.

## Dependency arrow

Higher modules import lower modules; lower modules know nothing about higher
ones:

```
┌────────────────────────────────────────────────────────────┐
│  src/routes/xrpc/$nsid.ts  +  src/routes/[.well-known]/*   │
│  src/routes/oauth/*  +  src/routes/admin/*                 │
│  (TanStack route shells)                                   │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│  xrpc/handlers/* — one file per NSID                       │
│  xrpc/proxy.ts  — Atproto-Proxy forwarding                 │
└────────────────────────┬───────────────────────────────────┘
                         │
   ┌─────────────────────┼──────────────────┬─────────────┐
   ▼                     ▼                  ▼             ▼
┌──────────┐    ┌──────────────┐   ┌──────────┐   ┌────────────┐
│ account/ │    │ repo/writes  │   │ oauth/   │   │  admin/    │
└────┬─────┘    └──────┬───────┘   └────┬─────┘   └─────┬──────┘
     │                 │                │               │
   ┌─┼────────┬────────┼────────────────┼──────┐        │
   ▼ ▼        ▼        ▼                ▼      ▼        │
┌──────┐ ┌───────────┐ ┌─────────┐ ┌──────────────┐    │
│ did/ │ │   auth/   │ │  blob/  │ │  sequencer/  │    │
└──┬───┘ └─────┬─────┘ └────┬────┘ └──────┬───────┘    │
   │           │            │             │             │
   └───────────┴────────────┴─────────────┴─────────────┘
                         │
                         ▼
        ┌────────────────────────────────┐
        │       repo/{mst,commit}        │
        └────────────────┬───────────────┘
                         │
                ┌────────▼─────────┐
                │  repo/blockstore │
                │  +  car/         │
                └────────┬─────────┘
                         │
                ┌────────▼─────────┐
                │       codec      │
                └──────────────────┘
```

`lexicon/` is referenced by every handler eventually but doesn't import any
PDS code itself.

## Each subsystem's contract

See the README in each subdirectory:

- [`codec/README.md`](./codec/README.md)
- [`repo/README.md`](./repo/README.md)
- [`car/README.md`](./car/README.md)
- [`did/README.md`](./did/README.md)
- [`lexicon/README.md`](./lexicon/README.md)
- [`xrpc/README.md`](./xrpc/README.md)
- [`auth/README.md`](./auth/README.md)
- [`blob/README.md`](./blob/README.md)
- [`sequencer/README.md`](./sequencer/README.md)
- [`account/README.md`](./account/README.md)
- [`admin/README.md`](./admin/README.md)
- [`oauth/README.md`](./oauth/README.md)
