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

| Group | Endpoints |
| --- | --- |
| `tools.ozone.moderation.*` | emitEvent (16 event types) · queryEvents · queryStatuses · getEvent · getRepo · getRecord · getRepos · getRecords · getSubjects · getAccountTimeline · getReporterStats · searchRepos · scheduleAction · listScheduledActions · cancelScheduledActions |
| `tools.ozone.team.*` | listMembers · addMember · updateMember · deleteMember |
| `tools.ozone.setting.*` | upsertOption · listOptions · removeOptions |
| `tools.ozone.set.*` | upsertSet · deleteSet · querySets · getValues · addValues · deleteValues |
| `tools.ozone.communication.*` | createTemplate · updateTemplate · deleteTemplate · listTemplates |
| `tools.ozone.verification.*` | grantVerifications · revokeVerifications · listVerifications |
| `tools.ozone.signature.*` | searchAccounts · findRelatedAccounts · findCorrelation |
| `tools.ozone.safelink.*` | addRule · updateRule · removeRule · queryRules · queryEvents |
| `com.atproto.label.*` | queryLabels · subscribeLabels (WebSocket) |
| `com.atproto.moderation.*` | createReport |

## Schema

Lives in `../../lib/db/schema/moderation_service.ts` and
`../../lib/db/schema/ozone_extensions.ts`.

| Table | Purpose |
| --- | --- |
| `mod_team` | Roster — DIDs authorised to operate the moderation surface, with `role` ∈ {`lead`, `moderator`}. |
| `mod_events` | Append-only event log. Every `emitEvent` call writes one row, with the full DAG-CBOR snapshot of the original input in `metadata` for fidelity. |
| `mod_subject_status` | Cache of the current state per subject (powering `queryStatuses` without replaying the log). Includes `tags[]`, `priority_score`, `appeal_state` columns set by their respective event types. |
| `mod_muted_reporters` | DIDs whose reports are de-emphasised in the queue. Flipped by `modEventMuteReporter` / `Unmute`. |
| `mod_report_resolution` | Links each `moderation_reports` row to the `mod_events` row that closed it. Auto-populated when a takedown / acknowledge / divert event is emitted. |
| `mod_scheduled_actions` | Deferred-execution moderation actions. The background sweep (`scheduled_actions.ts`) fires due rows via `applyEmitEvent`. |
| `labels` | Signed atproto labels emitted by `modEventLabel`. Public-readable via `com.atproto.label.queryLabels` / `subscribeLabels`. |
| `ozone_settings` | Key/value/scope store for `tools.ozone.setting.*`. |
| `ozone_sets` + `ozone_set_values` | Named subject sets for `tools.ozone.set.*`. |
| `ozone_comm_templates` | Operator-to-user email templates; consumed by `modEventEmail` and queried via `tools.ozone.communication.*`. |
| `verifications_index` | Per-(uri) verification grants issued by this labeler; mirrors the indexable dimensions of `app.bsky.graph.verification` records. |
| `account_signatures` | Per-(did, property, value) fingerprint store for `tools.ozone.signature.*`. |
| `safelink_rules` + `safelink_events` | URL-safety policy (block / warn / whitelist) per (url, pattern). |

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
