# Commits and signing

> 🚧 This chapter ships with the `src/pds/repo/commit.ts` session. The
> outline below is what you'll see when it lands.

A **commit** wraps an MST root in a small CBOR envelope and signs it. The
signature is what gives the repo authenticity — every relay and AppView
verifies it before accepting a commit into their index.

## Outline

1. **The commit object.** Fields: `did`, `version` (3), `data` (MST root
   CID), `rev` (TID), `prev` (null in v3), `sig` (bytes). Why each one is
   there.
2. **The signing key.** k256 / secp256k1. Each account has one, registered
   in the DID document.
3. **Building a commit.** Encode the unsigned commit, hash, sign, attach
   signature.
4. **Verifying a commit.** Reverse: decode, separate sig from body, fetch
   the verification key from the DID doc, verify.
5. **Rev numbers.** Why monotonic, why TID-shaped, what to do when clock
   skews.
6. **`prev` is dead.** Legacy field from v2 of the repo format; v3 doesn't
   chain commits. The firehose is the chain now.

## Where the code goes

- `src/pds/repo/commit.ts` — build, sign, verify.
- `src/pds/repo/keys.ts` — k256 keypair generation, multibase encoding.

## Spec links

- [Repository spec — Commit objects](https://atproto.com/specs/repository#commit-objects)
- [Cryptography spec](https://atproto.com/specs/cryptography)

← [06 — Merkle Search Trees](./06-merkle-search-tree.md) · → [08 — CAR files](./08-car-files.md)
