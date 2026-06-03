# A minimal client UI

So far in this book the PDS has been a server you talk to with `curl`. That's
a deliberate choice — XRPC is just HTTP + JSON, and the second you wrap it in
a real client you start hiding the wire. But there's a cost to it: someone
who clones this repo, runs `pnpm dev`, and points a browser at
`http://localhost:3000` gets a landing page and a docs site. They never see
the protocol in motion. They never log in, post, or watch the response
threading back from `com.atproto.repo.createRecord`.

This chapter adds a tiny client at `/app` so they can.

## What this client is, and is not

It does three things:

1. **`/app`** — a login form. Handle + password → a session JWT pair.
2. **`/app/feed`** — the logged-in user's own `app.bsky.feed.post` records,
   newest first.
3. **`/app/compose`** — a one-field "what's on your mind" textarea that
   creates a post record.

That's the whole product. It is **not** a Bluesky client. It cannot show
posts from accounts you follow, render mentions or links, attach images,
reply to threads, or count likes — because all of that is **AppView**
territory (chapter 17). The PDS doesn't know about social graphs; it stores
records, signs commits, and emits a firehose. An "app like Bluesky" is a
separate service that consumes a thousand PDSes' firehoses, indexes them,
and answers queries like "who replied to this URI" — which has no
counterpart on any single PDS.

If you want to build that, the firehose chapter (16) is where you start.
This chapter stays on the PDS side of the line.

## The session model

There are two ways to authenticate against this PDS:

- **OAuth** — covered in chapter 21. The proper, third-party-safe flow.
  Every modern client should use OAuth.
- **The legacy session JWT** — `com.atproto.server.createSession` returns an
  access + refresh JWT pair, and you put the access JWT in
  `Authorization: Bearer <jwt>`. This is what every Bluesky client used
  before the OAuth rollout and is what `atproto` shipped with originally.

We use the legacy flow for the in-repo client. The teaching reason is that
the OAuth dance — PAR, authorization, token endpoint, DPoP proofs — is its
own chapter; folding it into the very first client UI would bury the actual
moving parts (createSession, createRecord, listRecords) under boilerplate.
The practical reason is that this client only ever talks to its own PDS, on
the same origin, with full trust. There's no third party to protect.

The session pair lives in `localStorage` under `pds.session`:

```js
{
  did: 'did:plc:abc…',
  handle: 'alice.example.com',
  accessJwt: 'eyJ…',
  refreshJwt: 'eyJ…'
}
```

If you've grown up on "don't put tokens in localStorage" advice, the
intuition is right but the threat model is different: we already send the
access JWT to the server in an `Authorization` header from JavaScript, which
means JS already has it. An httpOnly cookie would be a defense against
*other* JavaScript on the page (XSS), but a same-origin, single-purpose
in-repo client has none of that surface. localStorage keeps the helper code
dependency-free and the data flow easy to read in the network tab.

### The refresh dance

Access JWTs expire (the default in this codebase is ~2 hours; see chapter
13). When they do, the server returns `401` with body
`{"error": "ExpiredToken", "message": "..."}`. The client has to:

1. POST to `/xrpc/com.atproto.server.refreshSession` with
   `Authorization: Bearer <refreshJwt>` — note that this endpoint uses the
   *refresh* token, not the access token. It's the only endpoint that does.
2. Receive a fresh access + refresh pair (refresh tokens rotate — see the
   `refreshSession` handler).
3. Write the new pair to localStorage.
4. Re-issue the original call with the new access token.

If step 1 also fails (refresh token is itself expired or revoked), the
session is dead. We clear localStorage and bounce the user to `/app` to log
in again.

All of that lives in `src/lib/client/xrpc.ts`, in one function:

```ts
export async function xrpcCall<T>(nsid: string, opts: XrpcOptions): Promise<T>
```

The views call `xrpcCall('com.atproto.repo.listRecords', { auth: true, … })`
and never see a JWT or a refresh request. If you've worked with the
`@atproto/api` package, this is roughly what its `Agent` class does — except
we hand-roll it in ~150 lines because the teaching premise of the rest of
this codebase ("re-implement, don't import") would be undercut by reaching
for a library here.

## Route guards

TanStack Router has two natural places to gate a route: `beforeLoad` (runs
before the loader, can `throw redirect(...)`) and the component itself
(rendered as a fallback). We use both:

- `beforeLoad`, when running in the browser, checks localStorage and
  redirects in either direction:
  - `/app` redirects to `/app/feed` if you already have a session,
  - `/app/feed` and `/app/compose` redirect to `/app` if you don't.
- The component renders `null` if `getSession()` returns null at render
  time — this is purely defensive (the guard should already have fired).

The `typeof window === 'undefined'` check on the guarded routes is there
because `beforeLoad` runs on the server during SSR too. We can't read
localStorage on the server, so we defer the check to the client. The server
renders the page as if logged in; the client either confirms or redirects
on hydration. A slightly nicer alternative is to send the session in a
cookie too — but that's another moving part for a chapter that's already
trying to stay small.

## A note on graphemes vs bytes

The `app.bsky.feed.post` lexicon caps text on two axes:

```json
{
  "maxLength": 3000,       // UTF-8 bytes
  "maxGraphemes": 300      // user-perceived characters
}
```

We enforce both client-side, so the user knows they're over the limit before
they hit Submit:

- **Bytes** — `new TextEncoder().encode(text).length`. Easy.
- **Graphemes** — `Intl.Segmenter` with `granularity: 'grapheme'`. Without
  it, an emoji-flag like 🇯🇵 (two code points: regional indicators J and P)
  would count as 2 instead of 1. `Intl.Segmenter` ships in every modern
  browser since 2022 and is implemented in V8/JavaScriptCore/SpiderMonkey.
  The fallback (which we keep for completeness) is `[...text].length` — that
  counts code points, which is wrong for ZWJ sequences and flags but close
  enough for plain text and matches the historical lexicon validator's
  fallback behaviour.

The server re-checks both via the lexicon bridge on `createRecord`. The
client check is UX, not security.

## What you'd add next

Read this as a list of self-contained side quests:

- **Reply threads** — a post can carry a `reply: { root, parent }` ref.
  Rendering them as threads requires an AppView; *creating* one is the same
  `createRecord` call with one extra field.
- **Image attachments** — POST to `com.atproto.repo.uploadBlob`, take the
  returned CID, embed it in the post record under `embed:
  app.bsky.embed.images`. The blob chapter (15) walks through the upload
  side; the embed lexicon shape lives in `app.bsky.embed.images`.
- **Profile editing** — `app.bsky.actor.profile` is a record at rkey
  `self` in the actor's own repo. `getRecord` to read, `putRecord` to write.
- **Identity resolution** — a real client lets you log into someone else's
  PDS by typing your handle. That means resolving `alice.example.com` to a
  DID, looking up the DID's PDS endpoint in its DID document, and pointing
  XRPC calls there. Chapter 4 covers the resolution; chapter 17 explains
  why federation makes this messy.
- **OAuth login as an alternative** — flip the login form into an "Authorize
  with your PDS" button that kicks off the OAuth flow from chapter 21.

## Adding images

The "what's on your mind" form ships with image attachments. They're the
smallest possible step up from text-only posts and they exercise a piece of
the protocol the rest of the chapter never touches: blobs.

There are exactly two endpoints involved:

- `com.atproto.repo.uploadBlob` — POST raw bytes, get a blob ref back. The
  Content-Type header is the file's MIME type (image/jpeg, image/png,
  image/webp); the body is the file as-is. No JSON envelope, no multipart
  wrapping. The response is `{ blob: { $type: 'blob', ref: { $link: '<cid>' },
  mimeType, size } }`. Chapter 15 covers the storage side; here the client
  just cares about the shape it gets back.
- `com.atproto.sync.getBlob` — GET `?did=<owner-did>&cid=<blob-cid>`. Public,
  unauthenticated, streams the bytes with the stored Content-Type. The
  feed's `<img src>` points straight at this URL.

The blob ref shape is worth pausing on. Inside the post record, an image
attachment is **not** a URL — it's a structural reference:

```json
{
  "$type": "blob",
  "ref": { "$link": "bafkreigh2ak..." },
  "mimeType": "image/jpeg",
  "size": 124512
}
```

The `$type: "blob"` and `ref: { $link }` are how the lexicon encodes a CID
link. In CBOR that's tag 42 around the binary CID; in JSON it's the `$link`
object. The record validator (chapter 9) checks that any field declared
`"type": "blob"` in the lexicon receives exactly this shape, and the
records writer (chapter 14 / wave 4B) then unpacks each `$link` and inserts
a row into `record_blobs` linking the post URI to the blob CID. That
attachment row is what keeps the blob from being garbage-collected (chapter
15) once an unreferenced upload ages out.

The `embed` field on `app.bsky.feed.post` is a lexicon **union**: it can be
`app.bsky.embed.images`, `app.bsky.embed.external`, or `app.bsky.embed.record`.
A union in atproto is discriminated by `$type` on the wire — that's why the
record carries `embed.$type` and the validator picks which schema to apply
based on it. For images:

```json
{
  "embed": {
    "$type": "app.bsky.embed.images",
    "images": [
      { "image": { "$type": "blob", "ref": { "$link": "..." }, ... }, "alt": "..." }
    ]
  }
}
```

The cap is 4 images per post (the lexicon's `maxLength`), and each image
has its own `image` blob + `alt` text. The client enforces 1 MB per image,
which is **lower** than the server's `uploadBlob` cap of 5 MB. Two reasons:
the `app.bsky.embed.images` lexicon's `image.maxSize` is exactly
`1_000_000`, so a 5 MB blob would upload fine but then the `createRecord`
call would fail lexicon validation; and real Bluesky compresses to ~1 MB
before upload anyway, so matching that keeps the example honest about what
production-shaped traffic looks like. Without an image-processing library
(sharp, jimp) the client can't transcode, so it just rejects oversize
files at the picker.

### Why this client only renders images

`app.bsky.embed.images` is the one embed variant whose data lives entirely
inside the PDS: the bytes are in our blob store, the metadata is in the
record, and we can build a `getBlob` URL from the post's own DID and the
embed's CID. We have everything we need.

The other variants are AppView-shaped:

- `app.bsky.embed.record` quotes another record by AT-URI. Rendering it
  requires fetching the target record — usually from a *different* PDS —
  resolving its author's handle and avatar, and recursing into its own
  embeds. That's a cross-account, federated graph traversal; it's what an
  AppView is built for (chapter 17).
- `app.bsky.embed.external` is a link card with a stored thumbnail blob.
  We could render the thumb (it's a blob like any other), but the title /
  description text isn't authoritative on the PDS — the standard practice
  is to re-scrape on the AppView side. A teaching PDS client showing
  half-implemented link cards would be more confusing than skipping them.
- `app.bsky.embed.video` needs a video player and HLS-style segmented
  variants the PDS doesn't produce.

So the feed renders a small monochrome "unknown embed: app.bsky.embed.X"
badge for anything that isn't images. The reader sees that the record
*has* an embed and what kind, without us pretending to render it.

## Try it

```bash
pnpm dev
```

In another terminal, create an account so you have somewhere to log in:

```bash
pnpm pds-admin create-invite | tee /tmp/invite
# …copy the code; then in a browser go to /app and… wait, there's no signup
# screen yet. Use curl for the createAccount call, then come back:
curl -sX POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H content-type:application/json \
  -d '{"handle":"alice.test","email":"a@example.test","password":"hunter2","inviteCode":"<paste>"}'
```

Now open `http://localhost:3000/app`, sign in with `alice.test` + `hunter2`,
write a post, and watch the network tab:

- `POST /xrpc/com.atproto.server.createSession` — returns the JWT pair.
- `POST /xrpc/com.atproto.repo.createRecord` — body has the post record;
  response carries the new AT-URI.
- `GET  /xrpc/com.atproto.repo.listRecords?repo=did:plc:…&collection=app.bsky.feed.post&reverse=true&limit=50`
  — the feed view.

The pattern that emerges, once you've watched the calls fly, is the whole
point of this chapter: the same endpoints you've been hitting with curl
through twenty-one chapters of explanation are exactly what a client uses.
A "client" is a typed wrapper over `fetch` with a JWT and a
URL-construction helper. That's the whole thing.

---

That's the end of the book as it stands. The PDS now has accounts,
authentication, signed repos with MST commits, blob storage, a firehose,
OAuth, and a client to see it all happen in. Anything beyond this — the
AppView, the relay, push notifications, video — is its own project.

Thanks for reading.
