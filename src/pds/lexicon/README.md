# `lexicon/` — Schemas for everything

A [Lexicon](https://atproto.com/specs/lexicon) is a JSON schema language with
a few AT-Protocol-specific extensions (CIDs, refs, blobs, unions discriminated
by `$type`). Every record, every XRPC procedure, every event on the firehose
is described by a lexicon.

This module:

- Bundles the upstream `com.atproto.*` and `app.bsky.*` lexicons we serve.
  The JSON files live under [`bundled/`](./bundled/) — Vite inlines them at
  build time via `import.meta.glob({ eager: true })` in
  [`loader.ts`](./loader.ts), so the production bundle is self-contained
  and there's no runtime `fs.readdir` of a source path that wouldn't exist
  on disk after `vite build`.
- Parses lexicon files into a typed schema graph.
- Generates input/output validators used by the XRPC dispatcher
  (see [`validate.ts`](./validate.ts) and the bridge at
  [`../xrpc/lexicon-bridge.ts`](../xrpc/lexicon-bridge.ts)).

Validation is **observe-only** by default: a mismatch logs but the
handler still runs. Set `LEXICON_STRICT=true` in the environment to
hard-reject — handler-side `zod` schemas are still the contract until
all bundled stubs are filled in.

See **[Chapter 09 — Lexicons](../../../docs/09-lexicons.md)**.
