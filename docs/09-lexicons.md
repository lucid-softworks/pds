# Lexicons

Every record on this PDS, every XRPC procedure it serves, every event on
its firehose has a **shape** — a list of fields, their types, what's
required, what's optional, what nested objects look like. The shape is
defined by a **lexicon**: a JSON schema file with a few AT-Protocol-specific
extensions, identified by an NSID.

This chapter covers what lexicons *are* and why they're shaped the way they
are. The implementation that turns a lexicon file into runtime validators
ships in a later session — by then you'll know exactly what those
validators have to do.

## A lexicon, by example

Here's a (lightly trimmed) version of
[`app.bsky.feed.post`](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json),
the schema that defines what a Bluesky post is:

```json
{
  "lexicon": 1,
  "id": "app.bsky.feed.post",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["text", "createdAt"],
        "properties": {
          "text": {
            "type": "string",
            "maxLength": 3000,
            "maxGraphemes": 300
          },
          "embed": {
            "type": "union",
            "refs": [
              "app.bsky.embed.images",
              "app.bsky.embed.video",
              "app.bsky.embed.external",
              "app.bsky.embed.record"
            ]
          },
          "reply": {
            "type": "ref",
            "ref": "app.bsky.feed.post#replyRef"
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    },
    "replyRef": {
      "type": "object",
      "required": ["root", "parent"],
      "properties": {
        "root": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
        "parent": { "type": "ref", "ref": "com.atproto.repo.strongRef" }
      }
    }
  }
}
```

A few things to notice:

- The file's *NSID* is in the `id` field: `app.bsky.feed.post`. That's also
  what a record's `$type` field will say when it conforms to this schema.
- The top of the lexicon is the `defs` map. The `main` definition is
  what's named by the file's NSID. Auxiliary types (like `replyRef` above)
  get internal names and are referenced as `<file-id>#<def-name>`.
- The `type: "record"` def has a `key` field declaring how rkeys are
  generated (`"tid"` = TID-shaped, `"literal:self"` = always the string
  "self", `"any"` = caller-chosen, `"nsid"` = an NSID).
- The schema language is JSON Schema with AT-Protocol-specific types
  (`cid-link`, `blob`, `union` discriminated by `$type`, `ref` for
  cross-file references).
- Fields like `maxGraphemes` and `format: datetime` are constraints the
  validator enforces. JSON Schema's own `format` is purely informational;
  here it's normative.

## Why a custom schema language?

The honest answer: because plain JSON Schema is *almost* enough but not
quite, and a small custom layer was cheaper than reimplementing the parts
of JSON Schema that the AT Protocol doesn't want.

What plain JSON Schema lacks for this use case:

1. **CID references.** A like points at a post by CID + URI. The CID is a
   typed value (the `cid-link` codec tag in CBOR, an object `{ $link }` in
   JSON), and JSON Schema doesn't have a built-in for that.
2. **Blob references.** Image attachments are `{ $type: "blob", ref, mimeType,
   size }`. Same shape problem.
3. **Discriminated unions.** AT Protocol unions are tagged: every variant
   carries a `$type` field that names its lexicon. Validators select the
   variant by reading `$type`. JSON Schema unions are untagged
   (`oneOf`/`anyOf`), which is solvable in pure JSON Schema but verbose.
4. **Graphemes and other Unicode-aware constraints.** A 300-grapheme limit
   on `text` enforces "300 user-visible characters" even when the text
   contains complex emoji that span multiple code points. Plain JSON
   Schema can constrain `maxLength` (UTF-16 code units), which gives the
   wrong answer for emoji.
5. **Method definitions.** Lexicons describe XRPC procedures too —
   parameters, input bodies, output bodies, error names. JSON Schema is
   schema-only; AT Protocol wanted a single language for the whole API
   surface.

So lexicons are JSON Schema + five-or-so extensions. A validator written
against one schema language can do everything the protocol needs.

## NSIDs

A **Namespaced Identifier** is a reverse-DNS dotted name:
`com.atproto.repo.createRecord`, `app.bsky.feed.post`, `dev.acme.notes.note`.
The leftmost label is a TLD; the namespace conceptually belongs to whoever
controls that TLD's DNS. There's no central registry of lexicons.

NSIDs serve two distinct roles:

1. **Collection names** inside a repository (e.g. `app.bsky.feed.post`).
2. **XRPC procedure names** on the wire (e.g. `com.atproto.repo.createRecord`).

The two namespaces are mostly disjoint by convention: `app.bsky.*` is
collection NSIDs, `com.atproto.*` is procedure NSIDs. There's nothing
preventing collisions — they're just different *uses* of the same kind of
string — but the conventions hold up well enough that no client confuses
them.

> 📖 **What if I want to invent a new lexicon?** Pick an NSID under a TLD
> you control (`dev.acme.cool.thing` works if you own `acme.dev`),
> write the JSON, publish it somewhere stable so other parties can read
> it. A PDS that doesn't recognize your NSID will store records under it
> anyway — it doesn't *care* — but an AppView that doesn't know your
> schema can't display them.

## The three kinds of definition

Every lexicon's `main` def is one of:

- **`record`** — a record type that lives in a repo at
  `at://<did>/<nsid>/<rkey>`. Has a `key` to declare rkey shape and a
  `record` field (the object schema).
- **`query`** — a GET XRPC method. Has `parameters` (query string args),
  `output` (response body schema), and `errors` (named error variants).
- **`procedure`** — a POST XRPC method. Like `query` plus an `input`
  (request body schema, usually JSON).
- **`subscription`** — a WebSocket XRPC method, used only for the
  firehose. Has `parameters` and a `message` schema (the union of all
  possible event types).

`defs` other than `main` are auxiliary — object shapes, unions, etc. —
referenced from `main` (and from other lexicons) via `<id>#<defname>`.

## Type vocabulary

The complete list of primitive types a lexicon can use:

| Type | What it is | Notes |
| --- | --- | --- |
| `null` | always null | |
| `boolean` | true / false | |
| `integer` | signed integer | optional `minimum`/`maximum` |
| `string` | UTF-8 string | optional `maxLength`, `maxGraphemes`, `format` |
| `bytes` | raw bytes | optional `minLength`/`maxLength` |
| `cid-link` | a CID | encodes as `{ $link }` in JSON, tag 42 in CBOR |
| `blob` | a blob ref | encodes as `{ $type: "blob", ref, mimeType, size }` |
| `array` | typed array | has `items` (any schema), optional bounds |
| `object` | nested object | has `properties` and `required` |
| `params` | URL query params | only valid inside a query/procedure |
| `token` | a sentinel value | used to declare named values (e.g. for enums) |
| `ref` | reference to another def | `ref: "app.bsky.feed.post#replyRef"` |
| `union` | tagged union | `refs: ["a", "b"]`; discriminated by `$type` |
| `unknown` | anything | escape hatch; validators just check it's present |

`format` on a string can be `datetime` (ISO 8601), `uri`, `at-uri`,
`did`, `handle`, `at-identifier` (handle or DID), `nsid`, `cid`,
`language`, `tid`, `record-key`.

## How XRPC fits in

A `procedure` or `query` definition is the spec for a single XRPC endpoint.
Sketch (from `com.atproto.server.createSession`):

```json
{
  "lexicon": 1,
  "id": "com.atproto.server.createSession",
  "defs": {
    "main": {
      "type": "procedure",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["identifier", "password"],
          "properties": {
            "identifier": { "type": "string" },
            "password": { "type": "string" }
          }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["accessJwt", "refreshJwt", "handle", "did"],
          "properties": {
            "accessJwt": { "type": "string" },
            "refreshJwt": { "type": "string" },
            "handle": { "type": "string", "format": "handle" },
            "did": { "type": "string", "format": "did" }
          }
        }
      },
      "errors": [
        { "name": "AccountTakedown" },
        { "name": "AuthFactorTokenRequired" }
      ]
    }
  }
}
```

When the lexicon-driven validator is wired up (a later chapter), the XRPC
dispatcher will:

1. Look up the lexicon for the requested NSID.
2. Validate the input body (or query string) against the `input.schema`.
3. Call the handler with the typed input.
4. Validate the handler's return value against `output.schema`.
5. Translate thrown errors to the named variants in `errors`.

The handler doesn't have to think about validation; the lexicon does it on
both sides.

## Validation: lenient on read, strict on write

The convention every implementation follows:

- **On write** (a client sending a record or procedure input): validate
  strictly. Reject unknown fields, malformed types, missing required
  fields. Return a 400 with a clear error.
- **On read** (a client receiving an output, or a relay receiving a
  firehose event): validate leniently. Unknown fields pass through. Future
  protocol extensions add fields; old clients shouldn't crash on them.

This asymmetry is what lets the protocol evolve. New fields can be added
to a record type without coordinating across every existing reader.

> 📖 **The same principle in action:** when the AT Protocol added the
> `langs` field to `app.bsky.feed.post`, every existing post became
> implicitly "no langs declared." Readers that didn't know about `langs`
> just skipped it. No flag-day migration.

## Bundled vs resolved

Two strategies for getting lexicons into a server:

1. **Bundled at build time.** The server ships with copies of every
   lexicon it understands, baked into the binary. New lexicons require a
   redeploy. This is what this PDS will do — we vendor the
   `com.atproto.*` and `app.bsky.*` lexicons we serve and validate
   against the bundled copies.

2. **Resolved at runtime.** Given an NSID, the server fetches the lexicon
   over HTTP (from a well-known URL based on the NSID's TLD). The server
   handles whatever it learns about. This is more flexible but adds a
   network dependency to validation, plus a caching strategy, plus a
   trust model for whose lexicon is authoritative.

The reference Bluesky PDS bundles. We bundle. Production self-hosters who
want to serve a new lexicon (their own `dev.acme.*`) add it to the bundle
and redeploy.

## Codegen vs runtime validation

For each lexicon, an implementation can either:

1. **Generate TypeScript types** at build time so handlers get typed input
   and output. The trade-off: stale types if lexicons change at runtime.
2. **Validate at runtime** using a generic schema interpreter. The
   trade-off: handler input/output is `unknown` until cast.

We pick **runtime** here because the docs site renders the bundled lexicons
live, and codegen-based docs would require recompilation every time we
edit a schema for the chapter. In production you'd typically codegen.

The implementation that lands in a later session will look roughly like:

```ts
const lexicon = loadLexicon('com.atproto.server.createSession')
const inputValidator = compileSchema(lexicon.defs.main.input.schema)
const outputValidator = compileSchema(lexicon.defs.main.output.schema)

// In the dispatcher:
const input = inputValidator(rawBodyJson)
const output = await handler({ input, ... })
return outputValidator(output)
```

Where `compileSchema` turns a lexicon schema into a `(value) => value`
function that throws on validation failure. (We'll likely build it as a
small interpreter rather than codegenning a validator — easier to read,
and performance isn't a bottleneck at PDS scale.)

## What's still missing

> 🚧 The validator and bundle now live in `src/pds/lexicon/`
> (`types.ts`, `loader.ts`, `validate.ts`, plus a `bundled/` tree of
> JSON), but they are **not yet wired into the XRPC dispatcher**.
> Handlers still validate by hand with `zod`
> (look at `src/pds/xrpc/handlers/com.atproto.server.createAccount.ts`).
> Cutting the dispatcher over is a follow-up — the validator just
> needed to exist first.

Today: of the 36 bundled lexicons, six are transcribed in full
(`app.bsky.feed.post`, `app.bsky.actor.profile`, `app.bsky.richtext.facet`,
all three `app.bsky.embed.*`, plus a handful of `com.atproto.*` defs +
`com.atproto.server.createAccount` / `createSession` and
`com.atproto.repo.createRecord` / `getRecord` / `strongRef`). The rest
are stubs marked `"TODO: full schema in a future session."` — enough that
refs into them resolve, not enough to actually constrain anything.

## Try it

```bash
pnpm tsx -e "import('./src/pds/lexicon/selfTest').then(m => m.runLexiconSelfTest())"
```

That loads the bundled catalog, compiles `app.bsky.feed.post`'s schema,
and runs four cases through the validator (valid post; missing
`text`; over `maxGraphemes`; a 1-grapheme family-emoji ZWJ sequence).
It prints `all self-tests passed` when the runtime is healthy.

## Exercises

1. Pick a lexicon you've never seen (browse
   [bluesky-social/atproto/lexicons/](https://github.com/bluesky-social/atproto/tree/main/lexicons)).
   Identify the `main` def's type, list its required fields, and decide
   what an *invalid* input to that lexicon would look like.
2. Why is `app.bsky.feed.post`'s `text` constrained on *graphemes* and not
   *code points*? Construct a 12-character string that's exactly 1
   grapheme.
3. The lexicon for `com.atproto.repo.uploadBlob` lets the client send
   *any* mime type. What stops a malicious client from uploading a
   gigabyte of `application/octet-stream`? Where does that constraint
   live?
4. Tagged unions identify variants by `$type`. What happens to a record
   whose embed has `$type: "app.bsky.embed.images.v2"` (which doesn't
   exist yet) when the lexicon for v2 ships?

## Up next

[Chapter 10 — XRPC](./10-xrpc.md) walks the HTTP dispatcher that turns
incoming requests into handler calls. A later session swaps each
handler's hand-written `zod` schema for a lookup into the lexicon
catalog this chapter just built.

← [08 — CAR files](./08-car-files.md) · → [10 — XRPC](./10-xrpc.md)
