-- 0006_email_confirmed_at: track confirmation timestamp on accounts
--
-- Nullable: existing rows (and any account that hasn't confirmed yet) carry
-- NULL. Confirmation sets it to now(); a subsequent email change clears it
-- back to NULL so the new address has to be confirmed in turn.
--
-- See chapter 13 — Authentication.

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "email_confirmed_at" timestamptz;
