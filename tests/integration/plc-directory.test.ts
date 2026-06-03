// Mock-plc.directory integration: exercise the non-local publish path
// end-to-end against a tiny in-process HTTP server that follows the
// directory's contract.
//
// In production `PDS_LOCAL_PLC=false` makes publishPlcOp POST to
// https://plc.directory and resolveDid hit it for external resolutions.
// In tests we don't want real network traffic, so we stand up an
// `http.createServer` on a random port and point the client at it via
// `PDS_PLC_DIRECTORY_URL`. The mock server collects every received
// request, lets the test assert on the signed PLC op's shape, and lets us
// stub specific response codes (409 idempotent, 5xx retryable, 400 hard
// failure).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

import { setupTestDbEnv, migrateProcessDb } from '../db'

setupTestDbEnv()
process.env.PDS_LOCAL_PLC = 'false'

// Pre-allocate a stub URL so the config loader doesn't reject; the test
// rebinds it per-test after the mock server picks a port.
process.env.PDS_PLC_DIRECTORY_URL = 'http://localhost:0'

let mockServer: Server | null = null
let mockPort = 0
type Captured = {
  method: string
  url: string
  body: string
  headers: Record<string, string | string[] | undefined>
}
let captured: Captured[] = []
let nextResponse: { status: number; body?: string } = { status: 200 }

beforeAll(async () => {
  await migrateProcessDb()
})

beforeEach(async () => {
  captured = []
  nextResponse = { status: 200 }
  await new Promise<void>((resolve, reject) => {
    mockServer = createServer((req, res) => handleMock(req, res))
    mockServer.once('error', reject)
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer!.address() as AddressInfo
      mockPort = addr.port
      process.env.PDS_PLC_DIRECTORY_URL = `http://127.0.0.1:${mockPort}`
      resolve()
    })
  })
})

afterEach(async () => {
  if (mockServer) {
    await new Promise<void>((r) => mockServer!.close(() => r()))
    mockServer = null
  }
})

function handleMock(req: IncomingMessage, res: ServerResponse): void {
  let body = ''
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8')
  })
  req.on('end', () => {
    captured.push({
      method: req.method ?? '',
      url: req.url ?? '',
      body,
      headers: req.headers,
    })
    res.statusCode = nextResponse.status
    res.setHeader('content-type', 'application/json')
    res.end(nextResponse.body ?? '{}')
  })
}

describe('publishPlcOp against a mock plc.directory', () => {
  it('POSTs the signed op to /<did> with a well-formed JSON body', async () => {
    const { publishPlcOp } = await import('~/pds/did/plc_client')
    const { buildGenesisPlc } = await import('~/pds/did/plc')
    const { generateKeypair } = await import('~/pds/repo/keys')

    const signingKey = generateKeypair()
    const rotationKey = generateKeypair()
    const plc = await buildGenesisPlc({
      handle: 'alice.test',
      rotationKeyPriv: rotationKey.privateKeyHex,
      rotationKeyDidKey: rotationKey.didKey,
      signingKeyDidKey: signingKey.didKey,
      pdsEndpoint: 'http://localhost:3000',
    })

    nextResponse = { status: 200 }
    await publishPlcOp({ did: plc.did, signedOpBytes: plc.signedBlock.bytes })

    expect(captured).toHaveLength(1)
    const c = captured[0]!
    expect(c.method).toBe('POST')
    expect(c.url).toBe(`/${encodeURIComponent(plc.did)}`)
    expect(c.headers['content-type']).toBe('application/json')

    const parsed = JSON.parse(c.body)
    expect(parsed.type).toBe('plc_operation')
    expect(parsed.sig).toBeTypeOf('string')
    expect(parsed.alsoKnownAs).toEqual(['at://alice.test'])
    expect(parsed.verificationMethods.atproto).toBe(signingKey.didKey)
    expect(parsed.rotationKeys).toEqual([rotationKey.didKey])
    expect(parsed.services.atproto_pds.endpoint).toBe('http://localhost:3000')
    expect(parsed.prev).toBeNull()
  })

  it('treats a 409 response as idempotent success', async () => {
    const { publishPlcOp } = await import('~/pds/did/plc_client')
    const { buildGenesisPlc } = await import('~/pds/did/plc')
    const { generateKeypair } = await import('~/pds/repo/keys')

    const signingKey = generateKeypair()
    const rotationKey = generateKeypair()
    const plc = await buildGenesisPlc({
      handle: 'bob.test',
      rotationKeyPriv: rotationKey.privateKeyHex,
      rotationKeyDidKey: rotationKey.didKey,
      signingKeyDidKey: signingKey.didKey,
      pdsEndpoint: 'http://localhost:3000',
    })

    nextResponse = { status: 409, body: '{"error":"already registered"}' }
    await expect(
      publishPlcOp({ did: plc.did, signedOpBytes: plc.signedBlock.bytes }),
    ).resolves.toBeUndefined()
    expect(captured).toHaveLength(1)
  })

  it('retries once on a 5xx and then succeeds on the second attempt', async () => {
    const { publishPlcOp } = await import('~/pds/did/plc_client')
    const { buildGenesisPlc } = await import('~/pds/did/plc')
    const { generateKeypair } = await import('~/pds/repo/keys')

    let firstHit = true
    if (mockServer) await new Promise<void>((r) => mockServer!.close(() => r()))
    mockServer = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        captured.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body,
          headers: req.headers,
        })
        if (firstHit) {
          firstHit = false
          res.statusCode = 502
          res.end('{"error":"upstream broken"}')
        } else {
          res.statusCode = 200
          res.end('{}')
        }
      })
    })
    await new Promise<void>((r) =>
      mockServer!.listen(0, '127.0.0.1', () => r()),
    )
    const addr = mockServer.address() as AddressInfo
    process.env.PDS_PLC_DIRECTORY_URL = `http://127.0.0.1:${addr.port}`

    const signingKey = generateKeypair()
    const rotationKey = generateKeypair()
    const plc = await buildGenesisPlc({
      handle: 'carol.test',
      rotationKeyPriv: rotationKey.privateKeyHex,
      rotationKeyDidKey: rotationKey.didKey,
      signingKeyDidKey: signingKey.didKey,
      pdsEndpoint: 'http://localhost:3000',
    })

    await expect(
      publishPlcOp({ did: plc.did, signedOpBytes: plc.signedBlock.bytes }),
    ).resolves.toBeUndefined()
    expect(captured.length).toBe(2)
  })

  it('surfaces a 400 as InvalidRequest without retrying', async () => {
    const { publishPlcOp } = await import('~/pds/did/plc_client')
    const { buildGenesisPlc } = await import('~/pds/did/plc')
    const { generateKeypair } = await import('~/pds/repo/keys')

    const signingKey = generateKeypair()
    const rotationKey = generateKeypair()
    const plc = await buildGenesisPlc({
      handle: 'dave.test',
      rotationKeyPriv: rotationKey.privateKeyHex,
      rotationKeyDidKey: rotationKey.didKey,
      signingKeyDidKey: signingKey.didKey,
      pdsEndpoint: 'http://localhost:3000',
    })

    nextResponse = { status: 400, body: '{"error":"malformed signature"}' }
    await expect(
      publishPlcOp({ did: plc.did, signedOpBytes: plc.signedBlock.bytes }),
    ).rejects.toThrow(/plc\.directory rejected op/)
    expect(captured).toHaveLength(1) // no retry on 4xx
  })
})

describe('fetchPlcDoc against the mock', () => {
  it('parses the returned DID document JSON', async () => {
    const { fetchPlcDoc } = await import('~/pds/did/plc_client')
    const did = 'did:plc:fakeabcdefghijklmnopqrst'
    const doc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      alsoKnownAs: ['at://alice.test'],
      verificationMethod: [],
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'http://localhost:3000',
        },
      ],
    }
    nextResponse = { status: 200, body: JSON.stringify(doc) }
    const fetched = await fetchPlcDoc(did)
    expect(fetched).toEqual(doc)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.method).toBe('GET')
    expect(captured[0]!.url).toBe(`/${encodeURIComponent(did)}`)
  })

  it('returns null on 404 (negative cache cue for the resolver)', async () => {
    const { fetchPlcDoc } = await import('~/pds/did/plc_client')
    nextResponse = { status: 404 }
    const fetched = await fetchPlcDoc('did:plc:notreal000000000000000')
    expect(fetched).toBeNull()
  })
})
