// DID document construction.
//
// Given an account row, build the DID document that we serve to resolvers.
// In a real did:plc setup the document is rendered by plc.directory; in our
// local-PLC mode the PDS renders it itself.
//
// One account on this PDS — the moderation-team lead — gets an extra
// service entry `#atproto_labeler` so downstream consumers can verify
// the signed labels we issue against the lead's atproto signing key.
// The lead is discovered from the `accounts.handle` match against
// `PDS_MOD_TEAM_HANDLE`; see chapter 24.

export type DidDocument = {
  '@context': string[]
  id: string
  alsoKnownAs: string[]
  verificationMethod: Array<{
    id: string
    type: 'Multikey'
    controller: string
    publicKeyMultibase: string
  }>
  service: Array<{
    id: string
    type: string
    serviceEndpoint: string
  }>
}

export function buildDidDocument(args: {
  did: string
  handle: string
  signingKeyMultibase: string
  pdsEndpoint: string
  /** When true, advertises this account as a labeler. The endpoint is
   *  reused — labelers share the PDS's URL because we host both. */
  isLabeler?: boolean
}): DidDocument {
  const service: DidDocument['service'] = [
    {
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: args.pdsEndpoint,
    },
  ]
  if (args.isLabeler) {
    service.push({
      id: '#atproto_labeler',
      type: 'AtprotoLabeler',
      serviceEndpoint: args.pdsEndpoint,
    })
  }
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      'https://w3id.org/security/suites/secp256k1-2019/v1',
    ],
    id: args.did,
    alsoKnownAs: [`at://${args.handle}`],
    verificationMethod: [
      {
        id: `${args.did}#atproto`,
        type: 'Multikey',
        controller: args.did,
        publicKeyMultibase: args.signingKeyMultibase,
      },
    ],
    service,
  }
}
