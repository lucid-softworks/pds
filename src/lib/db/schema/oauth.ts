import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

// ─── oauth_par ─────────────────────────────────────────────────────────────
//
// Pushed Authorization Requests (RFC 9126). The OAuth client POSTs the full
// /oauth/authorize parameter set to /oauth/par over the back channel; we
// stash it here keyed by a freshly-minted opaque `request_uri` and hand the
// handle back. The browser-mediated step then carries only that handle.
//
// Atproto OAuth requires PAR for every flow — clients can't pass the raw
// parameters on the front channel — which means this table is on the hot
// path for every authorize. Rows are short-lived (~60s) and consumed in
// /oauth/authorize.
//
// See chapter 21 — OAuth.
export const oauthPar = pgTable(
  'oauth_par',
  {
    requestUri: text('request_uri').primaryKey(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope').notNull(),
    state: text('state').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),
    dpopJkt: text('dpop_jkt').notNull(),
    loginHint: text('login_hint'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    expiresIdx: index('oauth_par_expires_idx').on(t.expiresAt),
  }),
)

// ─── oauth_codes ───────────────────────────────────────────────────────────
//
// One-shot authorization codes minted at the bottom of /oauth/authorize.
// Each row holds enough state to redeem at /oauth/token for an access +
// refresh JWT pair:
//
//   - did, scope            — what the code grants
//   - dpop_jkt              — pinned client key (from the PAR row)
//   - code_challenge        — PKCE challenge for redemption-time verify
//   - redirect_uri,         — cross-check against the redemption request to
//     client_id               foil mix-up attacks
//   - used                  — flipped to true on first redemption; replay
//                              attempts fail their second time around
//
// Codes are short-lived (~60s) — long enough for the browser redirect +
// token POST, short enough that a leaked code window is tiny.
//
// See chapter 21 — OAuth.
export const oauthCodes = pgTable(
  'oauth_codes',
  {
    code: text('code').primaryKey(),
    did: text('did')
      .notNull()
      .references(() => accounts.did, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),
    dpopJkt: text('dpop_jkt').notNull(),
    used: boolean('used').default(false).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    didIdx: index('oauth_codes_did_idx').on(t.did),
    expiresIdx: index('oauth_codes_expires_idx').on(t.expiresAt),
  }),
)

export type OauthParRow = typeof oauthPar.$inferSelect
export type NewOauthParRow = typeof oauthPar.$inferInsert
export type OauthCodeRow = typeof oauthCodes.$inferSelect
export type NewOauthCodeRow = typeof oauthCodes.$inferInsert
