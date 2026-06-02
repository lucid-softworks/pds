# `did/` — Identity

An account on the AT Protocol is identified by a [DID](https://www.w3.org/TR/did-1.0/) —
a stable, self-describing identifier separate from any human-readable handle.
This PDS supports the two method families that Bluesky uses:

- **did:plc** — registered with the [PLC directory](https://plc.directory/),
  rotated via signed operations. Most accounts use this.
- **did:web** — derived from a hostname, served as `/.well-known/did.json`.
  Used for accounts whose identity *is* a domain they control.

Files:

- `resolver.ts` — resolves a DID to its document, with caching.
- `plc.ts` — creates and rotates did:plc identifiers against a PLC server.
- `web.ts` — serves the PDS's own did:web document.
- `handle.ts` — bidirectional handle ↔ DID resolution (DNS TXT + well-known).

See **[Chapter 04 — Data model: DIDs, handles, AT URIs](../../../docs/04-data-model.md)**
and **[Chapter 12 — Account creation and did:plc](../../../docs/12-accounts.md)**.
