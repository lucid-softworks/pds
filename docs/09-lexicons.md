# Lexicons

> 🚧 This chapter ships with the `src/pds/lexicon/` session.

A [Lexicon](https://atproto.com/specs/lexicon) is the AT Protocol's schema
language. Every record type and every XRPC endpoint has one. Lexicons make
the protocol forward-compatible without coordination — anyone can publish a
new lexicon under their own NSID, and existing servers can either choose to
serve it or ignore it.

## Outline

1. **The shape of a lexicon file.** JSON schema with extensions: `cid-link`,
   `blob`, `union`, `ref`, `bytes`.
2. **NSIDs and namespacing.** Reverse-DNS, owned by the TLD holder, no
   central registry.
3. **Three kinds of definition.** `record`, `query`, `procedure`, plus
   `subscription` for the firehose.
4. **Validation.** How we turn a lexicon into an input validator and an
   output validator at startup.
5. **Bundling vs fetching.** We bundle the `com.atproto.*` and `app.bsky.*`
   lexicons at build time. A real PDS could resolve unknown lexicons at
   runtime; we don't, by choice.
6. **Codegen vs runtime.** Two approaches; we use runtime validation with
   zod so the docs can show the schemas live.

## Where the code goes

- `src/pds/lexicon/loader.ts` — read lexicon JSON, build a typed schema tree.
- `src/pds/lexicon/validate.ts` — input/output validators.
- `src/pds/lexicon/types.ts` — shared shape types.
- `src/pds/lexicon/bundled/` — the lexicons we ship with.

← [08 — CAR files](./08-car-files.md) · → [10 — XRPC](./10-xrpc.md)
