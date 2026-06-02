# `lexicon/` — Schemas for everything

A [Lexicon](https://atproto.com/specs/lexicon) is a JSON schema language with
a few AT-Protocol-specific extensions (CIDs, refs, blobs, unions discriminated
by `$type`). Every record, every XRPC procedure, every event on the firehose
is described by a lexicon.

This module:

- Bundles the upstream `com.atproto.*` and `app.bsky.*` lexicons we serve.
- Parses lexicon files into a typed schema graph.
- Generates input/output validators used by the XRPC dispatcher.

See **[Chapter 09 — Lexicons](../../../docs/09-lexicons.md)**.
