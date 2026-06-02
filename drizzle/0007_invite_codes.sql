-- 0007_invite_codes: invite_codes, invite_code_uses
--
-- Optional signup gate. When PDS_INVITE_REQUIRED=true, createAccount demands a
-- valid `inviteCode` and decrements `uses_remaining` in the same flow that
-- inserts the account. Admin operators mint codes via
-- com.atproto.server.createInviteCode(s); user-side personal-quota minting is
-- a follow-up.
--
-- See chapter 12 — Account creation.

CREATE TABLE IF NOT EXISTS "invite_codes" (
  "code"            text PRIMARY KEY,
  "created_by"      text REFERENCES "accounts"("did") ON DELETE SET NULL,
  "for_account"     text REFERENCES "accounts"("did") ON DELETE SET NULL,
  "uses_remaining"  integer NOT NULL DEFAULT 1,
  "uses_total"      integer NOT NULL DEFAULT 0,
  "disabled"        boolean NOT NULL DEFAULT false,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "invite_codes_created_by_idx" ON "invite_codes" ("created_by");
CREATE INDEX IF NOT EXISTS "invite_codes_for_account_idx" ON "invite_codes" ("for_account");

CREATE TABLE IF NOT EXISTS "invite_code_uses" (
  "code"     text NOT NULL REFERENCES "invite_codes"("code") ON DELETE CASCADE,
  "used_by"  text NOT NULL,
  "used_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("code", "used_by")
);
