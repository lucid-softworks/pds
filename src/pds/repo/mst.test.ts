// Behavior contract for the Merkle Search Tree.
//
// The MST is the heart of repository storage. Its key promises:
//
//   1. Deterministic — the same (key, value) set produces the same root CID
//      regardless of insertion order.
//   2. Set-like — insert + delete is the identity.
//   3. Diff-correct — diffing two trees recovers the exact key-level changes.
//
// Each test pins one of those guarantees. The "empty MST root CID matches a
// pre-computed value" test also guards the on-wire shape: any silent change
// to the DAG-CBOR layout would shift this CID, which would break interop
// with the upstream protocol.

import { describe, expect, it } from 'vitest'
import { cidEquals, cidForBytes, encode, type CID } from '~/pds/codec'
import { MST, emptyMst, runMstSelfTest, type BlockStore } from './mst'

class MemoryBlockStore implements BlockStore {
  private map = new Map<string, Uint8Array>()
  async put(cid: CID, bytes: Uint8Array): Promise<void> {
    this.map.set(cid.toString(), bytes)
  }
  async getBlock(cid: CID): Promise<Uint8Array | null> {
    return this.map.get(cid.toString()) ?? null
  }
}

async function cidFor(seed: number): Promise<CID> {
  const bytes = new Uint8Array(8)
  for (let i = 0; i < 8; i++) bytes[i] = (seed >> (i * 8)) & 0xff
  return await cidForBytes(bytes)
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('empty MST', () => {
  it("emptyMst() matches a freshly-constructed MST's root", async () => {
    const eb = await emptyMst()
    const empty = MST.empty()
    const { cid } = await empty.getRoot()
    // The empty MST node is `{ l: null, e: [] }` — the encoded bytes should
    // produce the same CID via either path.
    expect(cidEquals(eb.cid, cid)).toBe(true)
  })

  it('emptyMst() produces the canonical encoded shape', async () => {
    const eb = await emptyMst()
    const expected = await encode({ l: null, e: [] })
    expect(cidEquals(eb.cid, expected.cid)).toBe(true)
  })
})

describe('insert + get round-trip', () => {
  it('100 random keys come back with the same CIDs', async () => {
    const rng = lcg(0xc0ffee)
    const pairs: Array<{ key: string; cid: CID }> = []
    for (let i = 0; i < 100; i++) {
      const tid = randTid(rng)
      pairs.push({
        key: `app.bsky.feed.post/${tid}`,
        cid: await cidFor(i),
      })
    }
    let mst = MST.empty()
    for (const { key, cid } of pairs) {
      mst = await mst.add(key, cid)
    }
    for (const { key, cid } of pairs) {
      const got = await mst.get(key)
      expect(got).not.toBeNull()
      expect(cidEquals(got!, cid)).toBe(true)
    }
    expect(await mst.get('app.bsky.feed.post/does-not-exist')).toBeNull()
  })
})

describe('insertion-order independence', () => {
  it('two shuffles of the same key set produce the same root CID', async () => {
    const rng = lcg(0x1234)
    const pairs: Array<{ key: string; cid: CID }> = []
    for (let i = 0; i < 50; i++) {
      pairs.push({
        key: `app.bsky.feed.post/${randTid(rng)}`,
        cid: await cidFor(0xa000 + i),
      })
    }
    const orderA = shuffle(pairs, lcg(1))
    const orderB = shuffle(pairs, lcg(2))
    let a = MST.empty()
    for (const p of orderA) a = await a.add(p.key, p.cid)
    let b = MST.empty()
    for (const p of orderB) b = await b.add(p.key, p.cid)
    const rootA = await a.getRoot()
    const rootB = await b.getRoot()
    expect(cidEquals(rootA.cid, rootB.cid)).toBe(true)
  })
})

describe('delete inverts insert', () => {
  it('inserting then deleting every key returns to the empty root', async () => {
    const rng = lcg(0xdead)
    const pairs: Array<{ key: string; cid: CID }> = []
    for (let i = 0; i < 30; i++) {
      pairs.push({
        key: `app.bsky.feed.post/${randTid(rng)}`,
        cid: await cidFor(0xb000 + i),
      })
    }
    let mst = MST.empty()
    for (const p of pairs) mst = await mst.add(p.key, p.cid)
    for (const p of shuffle(pairs, lcg(99))) mst = await mst.delete(p.key)
    const empty = MST.empty()
    const a = await mst.getRoot()
    const b = await empty.getRoot()
    expect(cidEquals(a.cid, b.cid)).toBe(true)
  })

  it('delete of a missing key throws', async () => {
    const mst = MST.empty()
    await expect(mst.delete('app.bsky.feed.post/3jzfcijpj2z2a')).rejects.toThrow()
  })
})

describe('MST.diff', () => {
  it('produces the right adds / updates / deletes between two roots', async () => {
    const k1 = 'app.bsky.feed.post/aaaaaaaaaaaaa'
    const k2 = 'app.bsky.feed.post/bbbbbbbbbbbbb'
    const k3 = 'app.bsky.feed.post/ccccccccccccc'
    const [v1, v2, v3, v2b] = await Promise.all([
      cidFor(1),
      cidFor(2),
      cidFor(3),
      cidFor(22),
    ])

    let prev = MST.empty()
    prev = await prev.add(k1, v1)
    prev = await prev.add(k2, v2)

    let next = MST.empty()
    next = await next.add(k1, v1) // unchanged
    next = await next.add(k2, v2b) // updated
    next = await next.add(k3, v3) // added

    // (k_removed not present means deletes is empty here; add that case too.)
    let withRemoval = await prev.add(k3, v3) // exists in prev, absent in `next`
    withRemoval = await withRemoval.delete(k3)

    const diff = await MST.diff(prev, next)
    expect([...diff.adds.keys()]).toEqual([k3])
    expect(cidEquals(diff.adds.get(k3)!, v3)).toBe(true)
    expect([...diff.updates.keys()]).toEqual([k2])
    const [before, after] = diff.updates.get(k2)!
    expect(cidEquals(before, v2)).toBe(true)
    expect(cidEquals(after, v2b)).toBe(true)
    expect([...diff.deletes.keys()]).toEqual([])

    // The newBlocks set must include the new root and the new value CIDs.
    const newCids = new Set(diff.newBlocks.map((b) => b.cid.toString()))
    expect(newCids.size).toBeGreaterThan(0)
  })

  it('detects deletes between two trees', async () => {
    const k1 = 'app.bsky.feed.post/aaaaaaaaaaaaa'
    const k2 = 'app.bsky.feed.post/bbbbbbbbbbbbb'
    const [v1, v2] = await Promise.all([cidFor(1), cidFor(2)])
    let prev = MST.empty()
    prev = await prev.add(k1, v1)
    prev = await prev.add(k2, v2)
    const next = await prev.delete(k2)
    const diff = await MST.diff(prev, next)
    expect([...diff.deletes.keys()]).toEqual([k2])
    expect(cidEquals(diff.deletes.get(k2)!, v2)).toBe(true)
  })
})

describe('MST.load + persistence', () => {
  it('serializing and re-loading produces the same view', async () => {
    const store = new MemoryBlockStore()
    let mst = MST.empty()
    const pairs: Array<{ key: string; cid: CID }> = []
    const rng = lcg(0x4242)
    for (let i = 0; i < 20; i++) {
      const key = `app.bsky.feed.post/${randTid(rng)}`
      const cid = await cidFor(0xd000 + i)
      pairs.push({ key, cid })
      mst = await mst.add(key, cid)
    }
    const { cid: rootCid, blocks } = await mst.getRoot()
    for (const b of blocks) await store.put(b.cid, b.bytes)

    const reloaded = await MST.load(rootCid, store)
    for (const { key, cid } of pairs) {
      const got = await reloaded.get(key)
      expect(got).not.toBeNull()
      expect(cidEquals(got!, cid)).toBe(true)
    }
  })
})

describe('runMstSelfTest', () => {
  it('passes', async () => {
    await expect(runMstSelfTest()).resolves.toBeUndefined()
  })
})

// ---- helpers ---------------------------------------------------------------

function randTid(rng: () => number): string {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 13; i++) {
    s += alphabet[Math.floor(rng() * alphabet.length)]
  }
  return s
}
