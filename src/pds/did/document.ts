// DID document construction.
//
// Given an account row, build the DID document that we serve to resolvers.
// In a real did:plc setup the document is rendered by plc.directory; in our
// local-PLC mode the PDS renders it itself.

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
}): DidDocument {
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
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: args.pdsEndpoint,
      },
    ],
  }
}
