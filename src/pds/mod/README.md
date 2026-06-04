# mod/ — Ozone-shaped moderation, bundled

The PDS doubles as its own moderation service. The reference Bluesky
deployment ships moderation as a separate package
([`packages/ozone`][bsky-ozone]) running on its own host; we bundle
both into one Node process. The XRPC surface here matches the
canonical `tools.ozone.moderation.*` lexicons, so a real Ozone client
sees this PDS as an Ozone instance with no protocol gap.

[bsky-ozone]: https://github.com/bluesky-social/atproto/tree/main/packages/ozone

See [chapter 24](../../../docs/24-ozone-port.md) for the full
narrative; this file is the in-tree map.

## Modules

| File | What it does |
| --- | --- |
| [`team.ts`](./team.ts) | Lazy resolver + cache for the team-lead account (the one whose handle matches `PDS_MOD_TEAM_HANDLE`). Auto-seeds the `mod_team` row, runs the labeler bootstrap (PLC rotation + `app.bsky.labeler.service` self-record), and exposes the team roster helpers used by the `/mod/team` UI. |
| [`auth.ts`](./auth.ts) | `requireModerator()` — accepts admin Basic *or* an access JWT whose subject DID is in `mod_team`. Returns a discriminated union so handlers can branch on whether admin or a real moderator authenticated. |
| [`events.ts`](./events.ts) | `applyEmitEvent()` — the single write path for moderation events. Inserts `mod_events`, applies side effects on takedown / reverseTakedown (records / blobs / accounts), upserts `mod_subject_status`, signs + appends labels for `modEventLabel`. The XRPC handler and the `/mod` UI both call this. |

## XRPC handlers (registered in `../xrpc/handlers/index.ts`)

| NSID | File |
| --- | --- |
| `tools.ozone.moderation.emitEvent` | `../xrpc/handlers/tools.ozone.moderation.emitEvent.ts` |
| `tools.ozone.moderation.queryEvents` | `../xrpc/handlers/tools.ozone.moderation.queryEvents.ts` |
| `tools.ozone.moderation.queryStatuses` | `../xrpc/handlers/tools.ozone.moderation.queryStatuses.ts` |
| `tools.ozone.moderation.getEvent` | `../xrpc/handlers/tools.ozone.moderation.getEvent.ts` |
| `tools.ozone.moderation.getRepo` | `../xrpc/handlers/tools.ozone.moderation.getRepo.ts` |
| `tools.ozone.moderation.getRecord` | `../xrpc/handlers/tools.ozone.moderation.getRecord.ts` |
| `com.atproto.label.queryLabels` | `../xrpc/handlers/com.atproto.label.queryLabels.ts` |
| `com.atproto.moderation.createReport` | `../xrpc/handlers/com.atproto.moderation.createReport.ts` |

## Schema (see `../../lib/db/schema/moderation_service.ts`)

| Table | Purpose |
| --- | --- |
| `mod_team` | Roster — DIDs authorised to operate the moderation surface, with `role` ∈ {`lead`, `moderator`}. |
| `mod_events` | Append-only event log. Every `emitEvent` call writes one row, with the full DAG-CBOR snapshot of the original input in `metadata` for fidelity. |
| `mod_subject_status` | Cache of the current state per subject (powering `queryStatuses` without replaying the log). |
| `labels` | Signed atproto labels emitted by `modEventLabel`. Public-readable via `com.atproto.label.queryLabels`. |

## Bootstrap

Two paths, both keyed off `accounts.handle === cfg.modTeamHandle`:

- **Eager** — `createAccount` detects the match and builds the genesis
  PLC op with `#atproto_labeler` already in `services`, then writes
  the `app.bsky.labeler.service` self-record inside the signup
  transaction.
- **Lazy** — `getModTeamLead()` runs on first mod-surface read; the
  three `ensure*` routines (`ensureLeadRow`,
  `ensureLeadLabelerService`, `ensureLeadLabelerRecord`) are
  idempotent and self-heal when an existing account is renamed into
  the lead handle.

Both paths converge on the same end state: `mod_team` has a lead row,
plc.directory's DID document advertises `#atproto_labeler`, and the
account's repo holds the `app.bsky.labeler.service/self` record.
