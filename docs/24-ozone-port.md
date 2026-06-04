# Chapter 24 — Ozone-shaped moderation, bundled

By the end of chapter 19 we had a working operator surface: `/admin`
for handle-gated dashboard work, `com.atproto.admin.*` XRPC for
scripted operator actions, and a takedown column on records, blobs,
and accounts. That's everything *this PDS* needs to moderate *its
own* content.

It's not what the rest of the AT Protocol world expects, though. In
Bluesky's deployment, moderation lives in a separate service —
[Ozone][upstream-ozone], deployed independently from the PDS. Ozone
holds the event log (every takedown, every label, every operator
comment), the moderator roster, the report queue, and a sophisticated
team workflow on top. It exposes a different lexicon namespace —
`tools.ozone.*` — that moderation clients (the Bluesky web app's
"Ozone" interface, custom moderation tools) drive directly. Ozone is
*also* what advertises labels to the network: it signs each label
with its operator account's key and serves them via
`com.atproto.label.queryLabels` so AppViews can decide whether to
hide / blur / annotate a piece of content.

[upstream-ozone]: https://github.com/bluesky-social/atproto/tree/main/packages/ozone

Our learning port bundles both into one Node process. The /mod web
UI, the `tools.ozone.moderation.*` XRPC handlers, the labels table,
and the labeler DID-document service entry all ship in this repo
and run alongside the PDS itself. That's the central structural
divergence from upstream — and the rest of this chapter is about why
that's a reasonable choice for a self-hosted PDS *and* how the moving
parts fit together.

## Why bundle?

Upstream's split makes sense at Bluesky's scale: the moderation team
operates independently of the PDS operator team, and Ozone needs to
scale on a different axis (lots of moderators, lots of reports) than
the PDS. Two services let those scale separately.

For a self-hosted PDS, the split is mostly cost. You'd run a second
service that's idle most of the time, with a second database, second
deploy pipeline, second TLS cert. The moderation surface doesn't need
its own scaling envelope — a one-operator, ten-moderator deployment
fits comfortably in the same process as the PDS itself.

So we bundle. Same Node process, same Postgres database, same
deployment story. The two surfaces stay logically distinct (separate
schema, separate UI, separate auth gate) but share the runtime.

## What the team lead is

The moderation surface is "owned" by one atproto account on this PDS,
configurable via `PDS_MOD_TEAM_HANDLE` (default `mod.<hostname>`).
The operator creates that account through the normal signup flow —
nothing special is needed. Once it exists, three things change:

1. **A row in `mod_team`** with `role='lead'` is auto-seeded on first
   read.
2. **The account's DID document** grows an `#atproto_labeler` service
   entry pointing at the PDS's public URL. AppViews discovering the
   DID see both `#atproto_pds` and `#atproto_labeler` and treat the
   account as both a regular atproto user *and* a labeler.
3. **The labels table is signed with that account's key.** Every
   label emitted via `tools.ozone.moderation.emitEvent#modEventLabel`
   is signed with the team-lead's repo signing key — the same key
   that signs the account's own MST commits. Downstream consumers
   fetch the DID document, find the `#atproto` verificationMethod,
   and verify labels against that public key without further
   coordination.

The lead account's other facts — its handle, its records, its DID
document — work like any other atproto account. The moderation
surface piggybacks on the account; it doesn't replace it. Conceptually
the team lead *is* the labeler.

Additional moderators are atproto accounts added to `mod_team`
(`role='moderator'`). The v1 UI lists them read-only; add and remove
via direct SQL until a follow-up wires a roster page. There's no
"team admin" distinct from the team lead — the lead can act
unilaterally, and admin Basic always unlocks everything regardless of
team membership.

## The data model

Four tables (migration `0016_moderation_service.sql`):

```
mod_team             roster — DIDs and their roles
mod_events           append-only event log (every action ever taken)
mod_subject_status   denormalised current-state cache per subject
labels               signed labels (the public labeler payload)
```

`mod_events` is the source of truth. Every other read can be derived
from it. We keep `mod_subject_status` as a cache because
`queryStatuses` is on the hot path of any moderation dashboard and
replaying the event log per request would scale poorly.

A subject is identified by a discriminator:

- `com.atproto.admin.defs#repoRef` — `{ did }` — an account-level subject.
- `com.atproto.repo.strongRef` — `{ uri, cid }` — a record-level subject.

The shape comes straight from the upstream `tools.ozone.moderation.defs`
lexicon. `mod_events` and `mod_subject_status` store the discriminator
type in `subject_type` and the typed columns (`subject_did`,
`subject_uri`, `subject_cid`) reflect whichever subject shape was
involved.

## emitEvent — applying an action

The hot path. The lexicon defines 25+ event types
([`tools.ozone.moderation.defs#mod*Event`][defs-lexicon]); we
implement six of them in v1:

[defs-lexicon]: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/defs.json

| Event type | Side effect |
| --- | --- |
| `modEventTakedown` | sets `records.takedown_ref` / `blobs.takedown_ref` / `accounts.status='takendown'` |
| `modEventReverseTakedown` | clears the above |
| `modEventComment` | record-only; no state change |
| `modEventAcknowledge` | flips `mod_subject_status.review_state` to `acknowledged` |
| `modEventEscalate` | flips `review_state` to `escalated` |
| `modEventLabel` | signs + appends to the `labels` table |

Unsupported event types return `EventTypeNotSupported` with a clear
message — a future Bluesky-defined type doesn't silently no-op, so
when an upstream event type starts mattering you get explicit
feedback to wire it.

All emit-time logic lives in
[`src/pds/mod/events.ts`](../src/pds/mod/events.ts) — one
`applyEmitEvent()` function the XRPC handler *and* the `/mod` web UI
call. Both write the same row, run the same side effects, update the
same cache. There's exactly one path from "operator picks an action"
to "state changes."

### Auth

`requireModerator()` in
[`src/pds/mod/auth.ts`](../src/pds/mod/auth.ts) accepts two modes:

1. **Admin Basic** — the operator with the admin password is always
   allowed. Matches the "admin can do anything" invariant from
   chapter 19. The audit-trail attribution falls back to the
   team-lead DID since the action wasn't taken under a moderator
   identity.
2. **Moderator bearer** — a normal atproto access JWT whose subject
   DID is in `mod_team`. `createdBy` on the event input must equal
   that DID (otherwise a moderator could impersonate the lead in the
   audit log).

## queryEvents, queryStatuses, getEvent — the read surface

Three XRPC handlers cover the read side:

- `tools.ozone.moderation.queryEvents` — paginated history with
  filters (subject, types, createdBy, time range).
- `tools.ozone.moderation.queryStatuses` — paginated current-state
  view, reading from `mod_subject_status`.
- `tools.ozone.moderation.getEvent` — single event by id.

The event view is reconstructed from the DAG-CBOR snapshot
`emitEvent` persisted, so the response shape matches exactly what the
caller submitted — full fidelity round-trip.

## The labeler surface

`com.atproto.label.queryLabels` is the *public* read endpoint.
Anyone can call it without auth and ask "what labels has the labeler
applied to this URI?" That's how AppViews discover content
moderation decisions: they fetch labels from every labeler their
users have subscribed to and apply them to feeds.

Each label is signed with the team-lead's repo signing key. The
canonical signed form is DAG-CBOR of `{ src, uri, val, cts, neg, cid? }`
— same fields atproto's `@atproto/api` signs. The `sig` blob travels
on the wire alongside the label; consumers verify against the
labeler DID's `#atproto` verificationMethod.

**Subscribe — deferred.** The full Ozone surface also exposes
`com.atproto.label.subscribeLabels` over WebSocket so consumers can
tail new labels in real time. We don't ship that yet; v1 polls via
`queryLabels`. The implementation shape would mirror our firehose:
hand the request off to a WebSocket attached to the same Node http
server (the pattern from chapter 16), tail by `labels.seq` desc,
re-emit on insert.

## The `/mod` web UI

[`src/routes/mod/`](../src/routes/mod/) — server-rendered HTML
mirroring `/admin`'s aesthetic.

| Route | What it does |
| --- | --- |
| `/mod` | Dashboard: counts, subject-lookup form, recent reports, recent events. |
| `/mod/login` | Handle + password form; resulting DID must be in `mod_team`. |
| `/mod/logout` | Clear the session cookie. |
| `/mod/subject?q=…` | Single-subject view: state pills, action form, reports + events history. POST applies an action via `applyEmitEvent()`. |
| `/mod/events` | Paginated event history with filters. |
| `/mod/team` | Read-only roster. |

The session is a cookie-backed JWT scoped to `/mod`, separate from
the `/admin` cookie scope so the two surfaces don't bleed. Admin
Basic in the `Authorization` header always works — the "signed in
as" pill flips to read `admin (Basic)` and no cookie is required.

## How this maps onto a real Ozone

If you wanted to run *this* PDS as a federation member of a real
Ozone-driven moderation network, two things are true:

1. **A real Ozone client can drive our XRPC surface.** The
   `tools.ozone.moderation.*` endpoints match the canonical lexicon
   shapes — `emitEvent`, `queryEvents`, `queryStatuses`, `getEvent`.
   A client that speaks "talk to Ozone" sees this PDS as an Ozone
   instance.
2. **AppViews can subscribe to our labels.** The labeler DID-document
   service entry tells the network where to fetch our labels; the
   `queryLabels` endpoint serves them; the per-label signatures
   verify against our team-lead account's public key. No extra
   handshake.

The structural difference — one process vs. two — is invisible to
network consumers.

## Try it

```bash
# 1. Create the team-lead account.
curl -i -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{
    "handle": "mod.localhost",
    "email": "mod@example.com",
    "password": "correcthorsebatterystaple",
    "inviteCode": "..."
  }'

# 2. Capture the access JWT.
TOKEN=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"mod.localhost","password":"correcthorsebatterystaple"}' \
  | jq -r .accessJwt)

# 3. Emit a takedown on some account.
curl -i -X POST http://localhost:3000/xrpc/tools.ozone.moderation.emitEvent \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "event": { "$type": "tools.ozone.moderation.defs#modEventTakedown", "comment": "spam" },
    "subject": { "$type": "com.atproto.admin.defs#repoRef", "did": "did:plc:<target>" },
    "createdBy": "did:plc:<the mod.localhost DID>"
  }'

# 4. Apply a label.
curl -i -X POST http://localhost:3000/xrpc/tools.ozone.moderation.emitEvent \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "event": {
      "$type": "tools.ozone.moderation.defs#modEventLabel",
      "createLabelVals": ["spam"]
    },
    "subject": { "$type": "com.atproto.admin.defs#repoRef", "did": "did:plc:<target>" },
    "createdBy": "did:plc:<mod did>"
  }'

# 5. Read the public labels.
curl 'http://localhost:3000/xrpc/com.atproto.label.queryLabels?uriPatterns=did:plc:<target>'

# 6. See the team-lead DID document advertise the labeler.
curl 'http://localhost:3000/xrpc/com.atproto.repo.describeRepo?repo=mod.localhost' | jq .didDoc.service

# Then visit http://localhost:3000/mod (log in as mod.localhost).
```

## Known gaps

- **`subscribeLabels` (WebSocket).** Polled-only for now. Shape it
  like the firehose when you wire it.
- **Roster UI.** `/mod/team` is read-only; add/remove flows live as
  direct SQL inserts. A follow-up route would expose the obvious
  form.
- **Event types beyond the v1 six.** Mute, divert, email-out,
  scheduled takedown, age-assurance, identity-event, etc. The
  registry rejects them today; pick them up as needed.
- **Per-report resolution state.** Reports currently link to
  subjects, not to specific events. Ozone's full surface lets a
  moderator close a particular report against a particular event;
  we summarise instead. The schema has room to grow into it.

## Exercises

1. Add `modEventMute` / `modEventUnmute` to the supported set. The
   side effect would be an entry in a new `mod_muted_actors` table;
   the `/mod` UI gains a "muted" pill.
2. Wire `subscribeLabels` as a second WebSocket route alongside
   `subscribeRepos`. Reuse the `srvx`-attached-http server pattern
   from chapter 16; tail by `labels.seq` ascending.
3. Implement `tools.ozone.moderation.getRepo` and `getRecord` —
   moderation-context views that bundle current status + recent
   events + recent reports + applied labels for a single subject.
   Today the `/mod/subject` page does this with three direct DB
   queries; turning it into an XRPC endpoint lets external moderation
   tools render the same view.
