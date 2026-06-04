-- 0016_moderation_service: bundled Ozone-shaped moderation tables
--
-- The PDS doubles as its own moderation service (chapter 24). Four
-- new tables ship together so the surface is coherent from one
-- migration:
--
--   mod_team             — who's a moderator (atproto DIDs)
--   mod_events           — append-only log of every moderation action
--   mod_subject_status   — denormalised "current state" cache per
--                          subject; computed off mod_events on each
--                          emit, read on every queryStatuses call
--   labels               — emitted by `modEventLabel`; the labeler
--                          surface (`com.atproto.label.queryLabels`)
--                          reads them; future subscribeLabels (WS) will
--                          tail by `seq` desc
--
-- All four tables ship in one migration so a partial deploy can't leave
-- the moderation surface in a half-wired state.
--
-- See chapter 24 — Ozone-shaped moderation.

-- ─── mod_team ─────────────────────────────────────────────────────────────
--
-- Roster of accounts authorised to operate the moderation surface. The
-- "lead" is auto-seeded from the account whose handle matches
-- PDS_MOD_TEAM_HANDLE; additional moderators are added through the /mod
-- UI by the lead. Admin Basic auth bypasses this table entirely — an
-- operator with the admin password can always use the mod surface.
CREATE TABLE IF NOT EXISTS "mod_team" (
  "did"        text PRIMARY KEY,
  "role"       text NOT NULL CHECK ("role" IN ('lead', 'moderator')),
  "added_at"   timestamptz NOT NULL DEFAULT now(),
  "added_by"   text
);

-- ─── mod_events ───────────────────────────────────────────────────────────
--
-- Append-only event log. Mirrors Ozone's `mod_events` table. Each row
-- captures: the moderator action type (e.g. 'modEventTakedown'), the
-- subject the action was taken on, the operator who emitted it, plus a
-- full DAG-CBOR snapshot of the original event union so we can reproduce
-- the exact wire shape on `getEvent` / `queryEvents` reads.
--
-- subject_type is the lexicon $type discriminator:
--   - 'com.atproto.admin.defs#repoRef'   → subject_did set
--   - 'com.atproto.repo.strongRef'       → subject_uri + subject_cid set
CREATE TABLE IF NOT EXISTS "mod_events" (
  "id"                bigserial PRIMARY KEY,
  "event_type"        text NOT NULL,
  "subject_type"      text NOT NULL,
  "subject_did"       text,
  "subject_uri"       text,
  "subject_cid"       text,
  "subject_blob_cids" text[],
  "comment"           text,
  "metadata"          bytea NOT NULL,
  "created_by_did"    text NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "mod_events_subject_did_idx"
  ON "mod_events" ("subject_did", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "mod_events_subject_uri_idx"
  ON "mod_events" ("subject_uri", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "mod_events_created_at_idx"
  ON "mod_events" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "mod_events_event_type_idx"
  ON "mod_events" ("event_type", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "mod_events_created_by_idx"
  ON "mod_events" ("created_by_did", "created_at" DESC);

-- ─── mod_subject_status ───────────────────────────────────────────────────
--
-- One row per subject that has ever been actioned. Acts as the cache
-- powering `tools.ozone.moderation.queryStatuses` so the read path doesn't
-- replay the full event log on every call. The columns reflect *current*
-- in-force state, not history.
--
-- A subject is identified by its discriminator-aware composite key. For
-- accounts only `subject_did` is populated; for records all of did/uri/cid
-- carry their values. The primary key uses COALESCE on the nullable cols
-- so the row identity is unambiguous either way.
CREATE TABLE IF NOT EXISTS "mod_subject_status" (
  "id"               bigserial PRIMARY KEY,
  "subject_type"     text NOT NULL,
  "subject_did"      text NOT NULL,
  "subject_uri"      text,
  "subject_cid"      text,
  -- mod_events.id of the takedown event currently in force, NULL if not
  -- taken down.
  "takedown_event_id" bigint,
  -- 'open' | 'escalated' | 'acknowledged' | 'closed'. 'open' is the
  -- implicit default for new subjects; explicit acknowledge / escalate
  -- events flip this.
  "review_state"     text NOT NULL DEFAULT 'open',
  -- Denormalised: most recent operator comment, for the queryStatuses
  -- preview. Full comment history lives in mod_events.
  "last_comment"     text,
  "last_event_at"    timestamptz NOT NULL DEFAULT now(),
  "created_at"       timestamptz NOT NULL DEFAULT now()
);
-- One row per subject. Records vs accounts differ on whether subject_uri
-- is present, so the uniqueness expression COALESCEs NULL to '' to keep
-- account-shaped rows from colliding with each other on subject_did alone.
CREATE UNIQUE INDEX IF NOT EXISTS "mod_subject_status_subject_unique"
  ON "mod_subject_status" ("subject_did", COALESCE("subject_uri", ''));
CREATE INDEX IF NOT EXISTS "mod_subject_status_review_state_idx"
  ON "mod_subject_status" ("review_state", "last_event_at" DESC);
CREATE INDEX IF NOT EXISTS "mod_subject_status_takedown_idx"
  ON "mod_subject_status" ("takedown_event_id")
  WHERE "takedown_event_id" IS NOT NULL;

-- ─── labels ───────────────────────────────────────────────────────────────
--
-- Signed atproto labels emitted by `modEventLabel`. The labeler surface
-- (`com.atproto.label.queryLabels` today; `subscribeLabels` later) reads
-- these. Each row is signed with the mod-team lead's atproto signing key,
-- so a downstream consumer can verify against the labeler DID document
-- without further coordination.
--
-- `seq` is monotonic; `subscribeLabels` will tail by `seq` desc once it
-- ships. `neg` flips a previous-row's effect off (negation) — consumers
-- merge `(uri, val)` pairs and apply the latest `neg`.
CREATE TABLE IF NOT EXISTS "labels" (
  "seq"      bigserial PRIMARY KEY,
  "src"      text NOT NULL,
  "uri"      text NOT NULL,
  "cid"      text,
  "val"      text NOT NULL,
  "neg"      boolean NOT NULL DEFAULT false,
  "cts"      timestamptz NOT NULL DEFAULT now(),
  "exp"      timestamptz,
  "sig"      bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS "labels_uri_val_idx"
  ON "labels" ("uri", "val", "seq" DESC);
CREATE INDEX IF NOT EXISTS "labels_src_idx"
  ON "labels" ("src", "seq" DESC);
