// OAuth discovery documents.
//
// - Authorization Server metadata (RFC 8414) at
//   /.well-known/oauth-authorization-server — tells clients where to send
//   authorize / token / par / revoke requests, which signing algorithms we
//   accept on DPoP proofs, which scopes we grant, and so on.
// - Protected Resource metadata (RFC 9728) at
//   /.well-known/oauth-protected-resource — tells clients which
//   authorization server(s) issue valid tokens for *this* resource.
//
// Both are pure functions of the deployment's public URL. Clients fetch
// these at boot, so cache them aggressively at the edge if you like.
//
// See chapter 21 — OAuth.

import { getConfig } from '~/lib/config'

export function authServerMetadata(): Record<string, unknown> {
  const cfg = getConfig()
  const base = cfg.publicUrl
  return {
    // RFC 8414 — required fields first.
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    pushed_authorization_request_endpoint: `${base}/oauth/par`,
    jwks_uri: `${base}/oauth/jwks`,
    // What grants we support. `refresh_token` is live in chapter 21;
    // `authorization_code` is declared because the discovery doc has to
    // describe the full surface even when half of it is 501.
    grant_types_supported: ['authorization_code', 'refresh_token'],
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'fragment'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['atproto', 'transition:generic'],
    // DPoP — required on every token-endpoint call we accept.
    dpop_signing_alg_values_supported: ['ES256', 'ES256K'],
    require_pushed_authorization_requests: true,
    // Atproto OAuth profile: only the public-client flow is in scope for
    // PDS-side servers. `none` is the right value for the client auth
    // method on /token + /revoke (client identity comes from DPoP and PKCE).
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    // Atproto extensions.
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    // Token endpoint signing alg list — the access tokens we mint are ES256K
    // (signed with this PDS's OAuth signing key, see chapter 21).
    token_endpoint_auth_signing_alg_values_supported: ['ES256K'],
    // Subject identifiers we hand out: atproto DIDs ("public" in OIDC terms;
    // every client sees the same DID for the same user).
    subject_types_supported: ['public'],
  }
}

export function protectedResourceMetadata(): Record<string, unknown> {
  const cfg = getConfig()
  const base = cfg.publicUrl
  return {
    // RFC 9728 — describe this PDS as a protected resource and list the
    // authorization server(s) trusted to issue tokens for it. The PDS is
    // both, so the only entry is itself.
    resource: base,
    authorization_servers: [base],
    scopes_supported: ['atproto', 'transition:generic'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/docs/21-oauth`,
    // We require DPoP-bound bearer tokens on every authenticated request.
    dpop_bound_access_tokens_required: true,
  }
}
