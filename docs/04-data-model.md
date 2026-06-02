# DIDs, handles, and AT-URIs

Identity is the foundation. Before anyone can store a single byte on this
PDS, they need a DID; before a client can connect, it needs to resolve a
handle to a DID; before a record can be referenced from another record, it
needs an AT-URI. This chapter covers all three.

## DIDs

A [DID (Decentralized Identifier)](https://www.w3.org/TR/did-1.0/) is a URI
of the form `did:<method>:<method-specific-id>`. The AT Protocol uses two
methods.

### did:plc

The most common DID method on the network. The format is:

```
did:plc:<24 characters of base32-encoded sha256(genesis operation)>
```

Example: `did:plc:7iza6de2dwap2sbkpav7c6c6`.

These are issued by the **PLC directory** at `https://plc.directory`. To
mint one:

1. The PDS generates a signing key for the new account (k256/secp256k1).
2. It builds a *genesis operation*: a JSON object naming the rotation keys,
   the verification methods, the handle, and the PDS endpoint.
3. It signs the operation with the rotation key.
4. It POSTs the signed op to the PLC directory, which returns the DID
   (derived from the hash of the op).
5. The PLC directory stores the op in an append-only log keyed by the DID,
   and serves the resolved document at
   `https://plc.directory/did:plc:<id>`.

Rotations work the same way: a signed "rotate" op replaces the keys; the
directory verifies the signature comes from a current rotation key and
appends to the log. The DID never changes.

> ⚠️ This means the PDS does **not** own the DID. It owns the signing keys
> we put *into* the DID document. If the user gets their keys, they can
> migrate to a different PDS without our help.

In our code, `src/pds/did/plc.ts` will speak to plc.directory. For dev we
can run our own PLC server, but most of the time we just point at the
public directory.

### did:web

Domain-derived identity. The DID `did:web:alice.example.com` resolves to
the document at `https://alice.example.com/.well-known/did.json`. No
registry, no directory — the domain owner *is* the source of truth.

The PDS itself uses did:web for its own service DID. If your PDS is hosted
at `pds.example.com`, its service DID is `did:web:pds.example.com`, and it
serves its own DID document at `/.well-known/did.json`.

User accounts on this PDS can also use did:web (point at their own domain)
but it's less common because rotation is impossible without re-issuing
the domain's static document.

### Resolving a DID

Given a DID, you fetch its **DID document**:

```json
{
  "id": "did:plc:7iza6de2dwap2sbkpav7c6c6",
  "alsoKnownAs": ["at://alice.bsky.social"],
  "verificationMethod": [
    {
      "id": "did:plc:7iza6de2…#atproto",
      "type": "Multikey",
      "controller": "did:plc:7iza6de2…",
      "publicKeyMultibase": "z<base58-encoded k256 pub key>"
    }
  ],
  "service": [
    {
      "id": "#atproto_pds",
      "type": "AtprotoPersonalDataServer",
      "serviceEndpoint": "https://this-pds.example"
    }
  ]
}
```

The fields the PDS cares about:

- `alsoKnownAs[0]` — the account's current handle, prefixed with `at://`.
- `verificationMethod[*]` with `id` ending in `#atproto` — the public key
  the network will use to verify the repo's commit signatures.
- `service[*]` with `type=AtprotoPersonalDataServer` — the PDS endpoint.

If those three resolve correctly, everything downstream works.

## Handles

A handle is the human name: `alice.bsky.social`, `pfrazee.com`,
`atproto.com`. Per the [handle spec](https://atproto.com/specs/handle), a
handle:

- Is a valid DNS name.
- Can be ≤ 253 characters.
- Resolves to exactly one DID via either:
  - A `_atproto` DNS TXT record (`_atproto.alice.example.com TXT
    "did=did:plc:..."`)
  - Or an `/.well-known/atproto-did` HTTP endpoint that returns just the
    DID string.

**The handle does not own the DID**; the DID owns the handle. The link is
one-way (handle → DID) and the inverse (DID → handle) is whatever the DID
document says in `alsoKnownAs`. If a client looks up a handle and gets a
DID, but the DID's document doesn't list that handle in `alsoKnownAs`, the
resolution is *invalid* — the handle was unilaterally claimed and should be
rejected.

This bidirectional check is the trust root of the protocol. If you ever see
a "handle does not match DID" error in the wild, this is what's catching
it.

`src/pds/did/handle.ts` will implement both DNS and well-known resolution,
plus the bidirectional check.

## AT-URIs

The pointer format:

```
at://<authority>/<collection>/<rkey>
```

Where:

- `authority` is a DID (canonical) or a handle (display only — clients
  resolve handles to DIDs before storing references).
- `collection` is an NSID like `app.bsky.feed.post`.
- `rkey` is the record key, usually a TID.

Some examples:

```
at://did:plc:7iza6de…/app.bsky.feed.post/3jzfgg5jfgs2k
at://did:plc:7iza6de…/app.bsky.actor.profile/self
at://did:plc:7iza6de…                           ← just the repo
at://did:plc:7iza6de…/app.bsky.feed.post        ← the collection
```

Records refer to each other using AT-URIs *plus* a CID. The CID pins a
specific *version* of the target; the AT-URI says "this record at this
location, which currently happens to have these bytes." If the target is
edited later, the URI still points to it but the CID is stale.

A like, for example, looks roughly like:

```json
{
  "$type": "app.bsky.feed.like",
  "subject": {
    "uri": "at://did:plc:author/app.bsky.feed.post/3jzfgg5jfgs2k",
    "cid": "bafyreigp…"
  },
  "createdAt": "2026-06-02T18:34:00.000Z"
}
```

If the post is edited, the like still points at it (via the URI), but the
old CID is preserved as evidence of *what was liked*. The AppView decides
how to handle the version mismatch.

## TIDs

Record keys are usually **TIDs (Timestamp IDentifiers)**. The format,
described in the [TID spec](https://atproto.com/specs/tid):

- 13 characters of base32-sortable encoding.
- Encodes 53 bits of microseconds since epoch + 10 bits of clock identifier
  (a tiebreaker that varies per process).

```
3jzfgg5jfgs2k
```

What matters about TIDs in practice:

1. **They sort lexicographically in time order.** This is what makes the MST
   nice — collections naturally sort newest-last (or oldest-first), and
   range queries work as string ranges.
2. **They're locally generable.** Every PDS process picks a clock-id at
   startup, and the algorithm guarantees no two TIDs from the same process
   collide. Across processes, you might collide if you both pick the same
   clock-id *and* generate at the same microsecond, which is rare enough
   that we don't try to coordinate.
3. **They're not secret.** A TID exposes the creation time within a
   microsecond. Don't use TIDs where you need an unguessable identifier.

Implementation lives in `src/pds/repo/tid.ts` (lands with the repo chapter).

## A worked example

Alice opens her client. Here's what happens identity-wise:

1. **Handle resolution.** Client looks up `_atproto.alice.example.com`
   TXT, gets `did=did:plc:7iza6de…`.
2. **DID resolution.** Client GETs
   `https://plc.directory/did:plc:7iza6de…`, gets the DID document above.
3. **Endpoint discovery.** Client reads `service[type=...PDS].serviceEndpoint`
   → `https://this-pds.example`.
4. **Sign-in.** Client POSTs to
   `https://this-pds.example/xrpc/com.atproto.server.createSession` with
   her password. The PDS replies with a session JWT.
5. **All future requests** include the JWT and target the same PDS.

If Alice migrates to a different PDS later, only steps 3 and 4 change —
steps 1 and 2 still go to the same DNS and the same PLC directory. The
DID document gets updated to point at the new PDS endpoint. Federation
keeps working.

## Try it

Look at a real DID document:

```bash
curl -s https://plc.directory/did:plc:ewvi7nxzyoun6zhxrhs64oiz | jq
```

(That DID is paul.bsky.team's. It's public.)

Notice the same shape as the document above. The PDS endpoint is in
`service[type=AtprotoPersonalDataServer]`. The signing key is in
`verificationMethod`.

## Exercises

1. Look up `bsky.app`'s handle via DNS. What's its DID? What PDS hosts it?
2. Pick any AT-URI from a Bluesky post and parse it into `(did, collection, rkey)`.
3. Write the TID for *right now*. (You don't need code; convert microseconds
   to base32 by hand if you want, or jump ahead to `src/pds/repo/tid.ts`
   when it lands.)

## Up next

Identity is settled. Time to learn how *bytes* get addressed in this
system: [Chapter 05 — Content addressing and DAG-CBOR](./05-cid-and-dagcbor.md).
