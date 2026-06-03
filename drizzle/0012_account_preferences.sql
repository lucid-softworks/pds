-- app.bsky.actor.{get,put}Preferences storage.
--
-- Preferences are the bsky.app client's per-user settings: muted words,
-- content-filter levels, feed language, the home-feed pinned list, etc.
-- They live on the PDS (not the AppView) because they're user-owned
-- data the AppView reads back to personalise responses.
--
-- We store the JSON array verbatim — each item is shaped like
-- `{ "$type": "app.bsky.actor.defs#adultContentPref", … }`. putPreferences
-- replaces the whole array, getPreferences returns it; the AppView and
-- bsky.app together own the contents.
--
-- See chapter 22 — A minimal client UI (followup section on bsky.app
-- compatibility) and src/pds/xrpc/handlers/app.bsky.actor.{get,put}Preferences.ts.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS preferences TEXT NOT NULL DEFAULT '[]';
