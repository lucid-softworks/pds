-- 0014_invite_governance: invite governance columns
--
-- Two pieces of admin-driven invite policy show up in the upstream lexicon
-- that we previously had no plumbing for:
--
--   1. accounts.invites_disabled  — operator switch to revoke an
--      individual user's right to *mint* new invite codes. Defaults false
--      so the existing fleet of accounts behaves exactly as before.
--   2. invite_codes.disabled_at   — when the operator (or a code-owner-
--      level disable) flipped a code from usable to dead. We already had
--      a boolean `disabled` column on invite_codes; the timestamp is
--      additive for the audit trail and the admin getInviteCodes listing.
--
-- See chapter 19 — Moderation (invite governance section).

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "invites_disabled" boolean NOT NULL DEFAULT false;

ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "disabled_at" timestamptz;
