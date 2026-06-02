// Merkle Search Tree — minimal version.
//
// This file currently supports only construction of an *empty* MST so account
// creation can land. The full insert/delete/lookup/diff implementation grows
// in this file across the chapter-06 sessions. See `docs/06-merkle-search-tree.md`.
//
// The on-wire format of an MST node is fixed by the protocol:
//
//   type MstNode = {
//     l: CID | null      // leftmost subtree pointer
//     e: Array<{
//       p: number        // shared-prefix length with previous key
//       k: Uint8Array    // key bytes after the shared prefix
//       v: CID           // value CID
//       t: CID | null    // right-subtree pointer
//     }>
//   }
//
// An empty MST is `{ l: null, e: [] }` — that's what we encode and CID here.

import { encode, type Block, type CID } from '~/pds/codec'

export type MstNode = {
  l: CID | null
  e: MstEntry[]
}

export type MstEntry = {
  p: number
  k: Uint8Array
  v: CID
  t: CID | null
}

/** Build the empty MST root and return its block (bytes + CID). */
export async function emptyMst(): Promise<Block> {
  const node: MstNode = { l: null, e: [] }
  return await encode(node)
}
