# `did/` — Identity

An account on the AT Protocol is identified by a [DID](https://www.w3.org/TR/did-1.0/) —
a stable, self-describing identifier separate from any human-readable
handle. This PDS supports the two method families that Bluesky uses:

- **did:plc** — registered with the [PLC directory](https://plc.directory/),
  rotated via signed operations. Most accounts use this.
- **did:web** — derived from a hostname, served as `/.well-known/did.json`.
  Used for accounts whose identity *is* a domain they control.

## Files

| File | What |
| --- | --- |
| [`plc.ts`](./plc.ts) | did:plc genesis (`buildGenesisPlc` + `persistGenesisPlc`) and rotation (`rotatePlc`). Publishes to plc.directory in non-local mode. |
| [`plc_client.ts`](./plc_client.ts) | `publishPlcOp` (POST a signed op to plc.directory), `fetchPlcDoc` (resolve external did:plc), `fetchWebDoc` (resolve external did:web). No-op in local-PLC mode. |
| [`document.ts`](./document.ts) | `buildDidDocument` — produces the DID doc shape from an account row. |
| [`resolver.ts`](./resolver.ts) | `resolveLocalDid` / `resolveLocalHandle` for our own accounts. Re-exports `resolveDid` and `resetResolverCache` from the external resolver. |
| [`external_resolver.ts`](./external_resolver.ts) | `resolveDid` — unified resolver. Tries local accounts → plc.directory → did:web well-known. 5-minute positive / 30-second negative cache. |
| [`handle.ts`](./handle.ts) | Handle *syntax* validation (`isValidHandleSyntax`, `assertValidHandle`, `isReservedTld`). |
| [`handle_resolver.ts`](./handle_resolver.ts) | Cross-PDS handle resolution. Races `_atproto.<handle>` DNS TXT and `https://<handle>/.well-known/atproto-did` HTTPS, then runs the bidirectional check against the resolved DID's `alsoKnownAs`. |

## Chapters

- [Chapter 04 — Data model: DIDs, handles, AT-URIs](../../../docs/04-data-model.md) — the conceptual layer.
- [Chapter 12 — Account creation and did:plc](../../../docs/12-accounts.md) — genesis op, signing key, PLC mechanics.
- [Chapter 18 — Running in production](../../../docs/18-production.md) — `PDS_LOCAL_PLC` flag, handle wildcards, the production swap matrix.

## Tests

- [`handle.test.ts`](./handle.test.ts) — syntax positives + negatives, reserved-TLD policy.
- [`handle_resolver.test.ts`](./handle_resolver.test.ts) — DNS + well-known paths, bidirectional check, cache.
