# Commits and signing

The MST from the [previous chapter](./06-merkle-search-tree.md) gives us a
deterministic fingerprint for a repository's contents — one 36-byte root
CID that summarizes every record. But a CID by itself doesn't say *who*
the contents belong to. Anyone can hash a tree.

A **commit** fixes that. It's a tiny CBOR record that names the MST root,
tags it with a revision and a DID, and signs the whole thing with the
account's signing key. The signature turns "bytes that hash to X" into
"DID Y publishes state X at revision Z." It's the unit of authenticity the
firehose, relays, and AppViews check before doing anything with an
update.

## The commit object

In v3 of the repo format — the version we implement — a signed commit has
exactly six fields:

```ts
type SignedCommit = {
  did: string         // owner DID
  version: 3          // repo format version
  data: CID           // MST root CID
  rev: string         // TID-shaped revision marker
  prev: null          // legacy; always null in v3
  sig: Uint8Array     // 64-byte compact secp256k1 signature
}
```

Walking the fields one at a time:

- **`did`** identifies which repo this commit belongs to. Putting the DID
  *inside* the signed object prevents an attacker from lifting a valid
  signed commit and replaying it as if it belonged to another repo — the
  signature is bound to the DID, so swapping the DID invalidates the
  signature.
- **`version: 3`** declares the repo format. Version 2 was the previous
  on-disk shape (it chained commits — see below); v3 dropped the chain.
  Pinning the version inside the commit means an old client can tell
  immediately that it doesn't know how to validate the new shape.
- **`data`** is the CID of the MST root. The signature attests to *this
  exact tree*. Change one record, the root CID changes, the signature no
  longer verifies.
- **`rev`** is a TID — a 13-character base32-sortable timestamp that
  doubles as a monotonic counter. Two valid commits for the same DID with
  the same `rev` are a protocol violation; readers use `rev` to order
  events from a single repo.
- **`prev`** is dead weight in v3. We always emit `null` and we'll explain
  why in a moment.
- **`sig`** is the signature itself: 64 bytes of compact ECDSA over
  secp256k1, in low-S form, over the DAG-CBOR encoding of the other five
  fields.

That's it. Five strings/CIDs/null and a 64-byte blob. The whole thing
encodes to roughly 200 bytes.

## The signing key

The signature is produced by the account's **signing key** — a secp256k1
(also called k256) private scalar, 32 bytes. In `src/pds/repo/keys.ts` we
generate keypairs with `@noble/curves`:

```ts
const priv = secp256k1.utils.randomPrivateKey()
const pub = secp256k1.getPublicKey(priv, true) // compressed, 33 bytes
```

The public half is published in the DID document under
`verificationMethod[#atproto]`, encoded as a **Multikey**: a multicodec
varint prefix (`0xe7 0x01` for secp256k1-pub) followed by the 33-byte
compressed public key, then base58btc-multibase with a `z` prefix. We
covered the encoding in detail in [chapter 12](./12-accounts.md).

There's a second key per account — the **rotation key** — that authorizes
PLC operations against the DID itself. The signing key signs *commits*;
the rotation key signs *identity changes*. They have different
threat models and different rotation cadences. Chapter 12 covers the
rotation key in depth.

> ⚠️ **Difference from upstream.** The reference Bluesky PDS allows the
> signing key to be rotated by issuing a new PLC operation that updates
> `verificationMethod[#atproto]`. In this teaching port the signing key is
> fixed for the account's lifetime: there's no rotation flow and no UI for
> it. Production deployments would absolutely want one — compromised
> signing keys need to be replaceable without burning the DID. We'd add it
> alongside the PLC update flow in a later chapter.

## Building a commit

Here's the entire build function from `src/pds/repo/commit.ts`:

```ts
export async function buildSignedCommit(args: {
  did: string
  data: CID
  rev: string
  signingKeyPriv: string
}): Promise<Block> {
  const unsigned: UnsignedCommit = {
    did: args.did,
    version: 3,
    data: args.data,
    rev: args.rev,
    prev: null,
  }
  const unsignedBlock = await encode(unsigned)
  const sig = signBytes(args.signingKeyPriv, unsignedBlock.bytes)
  const signed: SignedCommit = { ...unsigned, sig }
  return await encode(signed)
}
```

Three lines do the real work: build the unsigned object, encode it, sign
those bytes, build the signed object, encode *that*. Both encodings go
through the codec from [chapter 05](./05-cid-and-dagcbor.md).

The pattern is worth pausing on. Why encode twice?

Because DAG-CBOR's deterministic profile mandates a canonical key order:
keys are sorted by byte length first, then lexicographically. So in the
signed commit, `sig` doesn't get appended at the end of the byte stream —
it lands at whatever position the canonical order says it lands at. For
our field set the order is `did`, `rev`, `sig`, `data`, `prev`, `version`
(by length: 3, 3, 3, 4, 4, 7). The signature lives in the *middle* of the
encoded bytes.

That rules out the obvious-but-wrong approach: "sign the dict with
`sig=null`, then patch the null with the real signature." Patching the
bytes would change the value at `sig`'s position from `null` (one byte) to
a 64-byte string, shifting every subsequent field's offset and breaking
the structure. We'd have to re-encode anyway.

The signing flow is therefore:

1. Encode the unsigned object (no `sig` field at all). The encoder sorts
   the five remaining keys canonically and produces a deterministic byte
   string.
2. Sign those bytes. `signBytes` hashes them with SHA-256 and runs
   `secp256k1.sign(hash, priv, { lowS: true })`, returning the 64-byte
   compact signature.
3. Build a new object with `sig` included and re-encode. The encoder
   re-sorts the now-six keys and produces a *different* byte string —
   the published commit.

The byte string from step 1 is ephemeral. It exists only long enough to be
hashed and signed. The byte string from step 3 is what we persist and
publish.

> 📖 **What we sign is the unsigned commit's bytes, not its CID.** Either
> would work — verifying a signature over the CID would be equivalent
> because the CID is just `sha256(bytes)` wrapped in metadata — but the
> spec picks "sign the bytes" and we follow.

## Verifying

`verifyCommit` runs the same dance in reverse:

```ts
export async function verifyCommit(
  signedCommitBytes: Uint8Array,
  publicKeyMultibase: string,
): Promise<boolean> {
  const signed = await decode<SignedCommit>(signedCommitBytes)
  const { sig, ...unsigned } = signed
  if (!sig || !(sig instanceof Uint8Array)) return false
  const unsignedBlock = await encode(unsigned)
  return verifyBytes(publicKeyMultibase, unsignedBlock.bytes, sig)
}
```

Decode the signed commit. Pull `sig` off. Re-encode the remaining five
fields. The bytes we just produced are byte-for-byte identical to the
bytes that were signed during `buildSignedCommit`, because DAG-CBOR is
deterministic. Verify the signature over those bytes.

The critical point — and the place implementations get this wrong — is
where the **public key** comes from. Notice it's a parameter to
`verifyCommit`. The function does not extract a public key from the
commit. It can't: the commit doesn't carry one.

The caller is responsible for resolving the commit's `did` to the account's
DID document and pulling `verificationMethod[#atproto]` out of it. The DID
document is the source of truth for which key may sign for that DID. A
commit that claims to belong to `did:plc:foo` but is signed by some other
key isn't *cryptographically invalid* — the math works fine with any
matching pair. It's *unauthorized*. The chain of trust runs through the
DID system.

> 📖 **What does "authorized" mean operationally?** A relay fetches the
> commit, resolves the `did` field, gets the signing key from the DID doc,
> and runs `verifyCommit`. If the DID's signing key changes (via a future
> PLC operation), commits signed by the old key stop verifying — which is
> exactly what should happen if the old key was compromised. The DID
> document is the rotation point; the commit just references the DID.

## Rev numbers

The `rev` field is a TID — Timestamp ID, the 13-character base32-sortable
encoding we cover in `src/pds/repo/tid.ts`. Two facts about TIDs matter
here:

1. They sort the way you'd expect timestamps to sort: lexicographic order
   matches chronological order.
2. They are *monotonically increasing* within a process. `nextTid()` keeps
   a counter so that even if the wall clock returns the same microsecond
   twice (or, worse, goes backwards), each call returns a strictly larger
   TID than the previous one.

For a repository, `rev` is the version number that says "this commit is
newer than that one." A reader that has seen revision `3jzfgg5jfgs2k` and
receives revision `3jzfgg5jfgs2j` knows it can ignore the older one
without trusting any external ordering. The firehose uses `rev` to detect
out-of-order delivery and to checkpoint resumable subscriptions.

What about clock skew across processes? Two PDSes (or two replicas of one
PDS) might disagree by a few seconds. The single-process monotonicity in
`nextTid()` doesn't help across machines. The answer is that
cross-process ordering is the firehose's job, not the commit's: every
event the firehose emits also gets a sequence number, and that sequence
number is the global ordering. The `rev` field is for ordering events
*within a single repo*, where the writer is unambiguous. We'll come back
to this in [chapter 16 — Firehose](./16-firehose.md).

## `prev` is null in v3

The `prev` field is a fossil. In v2 of the repo format, every commit
carried the CID of the previous commit, so commits formed a hash chain
exactly like git. v3 dropped the chain.

Three reasons:

1. **The firehose is the chain.** Every commit a PDS emits goes onto the
   firehose with an ever-increasing sequence number. Downstream consumers
   reconstruct history by consuming the firehose in order, not by walking
   `prev` pointers in the repo. The chain moved from inside the repo to
   the transport layer.
2. **Chained commits made resets and restores painful.** Rewriting the
   tail of history meant re-signing every subsequent commit because each
   `prev` had to be updated, which cascaded. Account migration between
   PDSes had the same problem.
3. **The MST already supports diff.** Given two commit roots, you can diff
   their MSTs to know exactly what changed. You don't need a `prev`
   pointer to reason about evolution between two snapshots.

So `prev` carries no information. Yet we still emit `null` rather than
omitting the key, because the [repository spec's commit object
lexicon](https://atproto.com/specs/repository#commit-objects) lists `prev`
as required. Removing it would change the canonical DAG-CBOR encoding —
different byte length, different CID — and we'd disagree with every other
PDS on the same logical state. A dead 6-byte field is cheaper than a
fork.

## Low-S signatures

ECDSA signatures over secp256k1 have a subtle malleability: for every
valid signature `(r, s)`, the pair `(r, n - s)` (where `n` is the curve
order) is also valid for the same message and public key. Both verify.
That means a signature isn't a unique identifier for "this message was
signed by this key" — there are two of them.

For most cryptographic purposes that's annoying but tolerable. For a
content-addressed protocol it's a disaster: if the signature is part of
the bytes you hash to produce a CID, then the same logical commit has two
possible CIDs, depending on which form of the signature the signer
emitted. Two PDSes implementing the spec correctly could disagree on the
CID of the same commit.

The AT Protocol fixes this by mandating **low-S form**: of the two valid
signatures, only the one with `s < n / 2` is acceptable. Verifiers reject
the other. This makes signatures canonical.

`@noble/curves` does the right thing for us via the `{ lowS: true }` flag,
which both signing and verification pass:

```ts
secp256k1.sign(hash, priv, { lowS: true })       // produces low-S
secp256k1.verify(sig, hash, pub, { lowS: true }) // rejects high-S
```

You can see both in `src/pds/repo/keys.ts`.

## A worked example

Pseudo-concrete numbers for a freshly created account whose `data` field
points at the empty MST node `{ l: null, e: [] }`:

- `did`: `did:plc:g7k4q6y6jmrr3hgpwxs4f5n2` (24-char base32 method id).
- `data`: `bafyreig5p…` — 36-byte multihash + framing.
- `rev`: `3kxbq2sf2lj2k` — a freshly minted TID.
- `prev`: `null`. `version`: `3`.

The unsigned commit DAG-CBOR-encodes to around 90 bytes (most of it is the
DID string and the CID's multihash). We SHA-256 those bytes, sign the
32-byte digest with the secp256k1 private scalar, and get a 64-byte
compact low-S signature.

Rebuild the commit with `sig` added and re-encode. The signed commit
weighs in at about 160 bytes — the unsigned bytes plus the canonical-
position insertion of a 64-byte byte-string field. That blob lands in
`repo_blocks` and its CID becomes `repos.root_cid`.

## Try it

The minimal end-to-end flow, in one shell command:

```bash
pnpm tsx -e '
import { generateKeypair } from "./src/pds/repo/keys"
import { emptyMst } from "./src/pds/repo/mst"
import { buildSignedCommit, verifyCommit, decodeCommit } from "./src/pds/repo/commit"
import { nextTid } from "./src/pds/repo/tid"

const kp = generateKeypair()
const mst = await emptyMst()
const commit = await buildSignedCommit({
  did: "did:plc:demo",
  data: mst.cid,
  rev: nextTid(),
  signingKeyPriv: kp.privateKeyHex,
})
console.log("commit CID:", commit.cid.toString())
console.log("commit bytes:", commit.bytes.length)
console.log("decoded:", await decodeCommit(commit.bytes))
console.log("verifies:", await verifyCommit(commit.bytes, kp.publicKeyMultibase))
'
```

You should see the commit decode back into a five-field object plus `sig`,
and `verifies: true`.

To inspect a real account's commit after running the `createAccount` flow
from [chapter 12](./12-accounts.md), open `DATABASE_URL=pglite pnpm
drizzle-kit studio`, find the `repos.root_cid` for your DID, look up the
matching row in `repo_blocks`, then verify the bytes against the account's
stored public key:

```ts
import { verifyCommit } from '~/pds/repo/commit'
const ok = await verifyCommit(bytesFromDb, account.signingKeyPub)
```

You should get `true`. Toggle a single byte and try again; you should get
`false`. The signature is over the exact bytes.

## Exercises

1. The `did` field appears inside the commit even though we already store
   the commit's CID under its DID in the `repos` table. Why bother
   embedding it? (Hint: think about what happens to a commit's bytes when
   they leave our database — to a CAR consumer, to the firehose, into
   somebody else's blockstore.)
2. What would break if we signed the genesis PLC op with the *signing* key
   instead of the *rotation* key? You'll need to think about who controls
   what after each scenario, and what migration would look like.
3. An attacker pulls a victim's signed commit off the firehose. What can
   they do with it? What can't they do with it? Be specific about what
   the signature does and doesn't authorize.
4. The verifier re-encodes the unsigned commit and checks the signature
   over those bytes. Why does it have to *re-encode* rather than just
   slicing the `sig` field out of the original byte stream? Sketch what a
   "slice the sig out" implementation would look like and where it would
   go wrong.

## Up next

We have signed roots. The next step is moving them around: serializing a
commit and the blocks it references into a single byte stream a peer can
verify offline. That's what [chapter 08 — CAR
files](./08-car-files.md) is about.

← [06 — Merkle Search Trees](./06-merkle-search-tree.md) · → [08 — CAR files](./08-car-files.md)
