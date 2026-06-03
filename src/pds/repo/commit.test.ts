// Behavior contract for repo commits.
//
// A repo commit is the *only* signed object in the system. Verification
// guarantees that the data CID it names — the MST root for the repo at this
// revision — was endorsed by the holder of the account's signing key.
// Tampering with the data CID, the rev, or the DID must invalidate the
// signature; verifying with the wrong key must invalidate too.

import { describe, expect, it } from 'vitest'
import { cidForBytes, encode } from '~/pds/codec'
import { buildSignedCommit, decodeCommit, verifyCommit } from './commit'
import { generateKeypair } from './keys'
import { nextTid } from './tid'

let cidCounter = 0
async function aRandomCid() {
  // Distinct bytes → distinct CID. Counter survives across the suite so
  // every call yields a fresh content address.
  cidCounter++
  const bytes = new Uint8Array(16)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (cidCounter * 31 + i * 7) & 0xff
  }
  return await cidForBytes(bytes)
}

describe('buildSignedCommit + verifyCommit', () => {
  it('round-trips: a freshly-signed commit verifies against its own pubkey', async () => {
    const kp = generateKeypair()
    const data = await aRandomCid()
    const rev = nextTid()
    const block = await buildSignedCommit({
      did: 'did:plc:fakedidfakedidfakedidfak',
      data,
      rev,
      signingKeyPriv: kp.privateKeyHex,
    })
    const ok = await verifyCommit(block.bytes, kp.publicKeyMultibase)
    expect(ok).toBe(true)
    const decoded = await decodeCommit(block.bytes)
    expect(decoded.did).toBe('did:plc:fakedidfakedidfakedidfak')
    expect(decoded.rev).toBe(rev)
    expect(decoded.version).toBe(3)
    expect(decoded.prev).toBeNull()
  })
})

describe('tamper detection', () => {
  it('verification fails when the data CID is swapped after signing', async () => {
    const kp = generateKeypair()
    const originalData = await aRandomCid()
    const block = await buildSignedCommit({
      did: 'did:plc:fakedidfakedidfakedidfak',
      data: originalData,
      rev: nextTid(),
      signingKeyPriv: kp.privateKeyHex,
    })
    // Build a tampered commit: re-encode the decoded commit with a different
    // data CID but keep the original signature.
    const decoded = await decodeCommit(block.bytes)
    const swappedData = await aRandomCid()
    const tampered = await encode({ ...decoded, data: swappedData })
    const ok = await verifyCommit(tampered.bytes, kp.publicKeyMultibase)
    expect(ok).toBe(false)
  })

  it('verification fails when the rev is swapped after signing', async () => {
    const kp = generateKeypair()
    const block = await buildSignedCommit({
      did: 'did:plc:fakedidfakedidfakedidfak',
      data: await aRandomCid(),
      rev: nextTid(),
      signingKeyPriv: kp.privateKeyHex,
    })
    const decoded = await decodeCommit(block.bytes)
    const tampered = await encode({ ...decoded, rev: nextTid() })
    const ok = await verifyCommit(tampered.bytes, kp.publicKeyMultibase)
    expect(ok).toBe(false)
  })

  it('verification fails when the wrong public key is supplied', async () => {
    const signer = generateKeypair()
    const stranger = generateKeypair()
    const block = await buildSignedCommit({
      did: 'did:plc:fakedidfakedidfakedidfak',
      data: await aRandomCid(),
      rev: nextTid(),
      signingKeyPriv: signer.privateKeyHex,
    })
    const ok = await verifyCommit(block.bytes, stranger.publicKeyMultibase)
    expect(ok).toBe(false)
  })
})
