// Lexicon catalog loader.
//
// Reads every bundled JSON file at module-load time, parses it into
// `LexiconDoc`, and exposes lookup + reference resolution. Parsing is
// intentionally trusting — the JSON files are checked into the repo, so a
// malformed one is a build bug, not a runtime threat. We do validate the
// top-level shape (lexicon == 1, id present) so the failure mode is obvious.
//
// We pull every file through Vite's `import.meta.glob({ eager: true })` so
// the JSON is inlined at *build* time. This survives the production build —
// the previous `fs.readdir` walk worked in dev/tests (where the file tree
// is the source tree) but broke under `vite build` because the bundled
// SSR output has no concept of a "bundled/" directory next to the loader.
//
// See chapter 9 — Lexicons, and chapter 18 — Running in production.

import type { LexUserType, LexiconDoc } from './types'

export type LexiconCatalog = {
  get(nsid: string): LexiconDoc | undefined
  /** Resolve a ref like `foo.bar.baz#defname`, or `foo.bar.baz` (= main), or
   *  `#defname` (relative to `contextNsid`). Returns undefined if unknown. */
  resolve(ref: string, contextNsid?: string): LexUserType | undefined
  all(): Iterable<LexiconDoc>
}

// Vite inlines every matching JSON at build time. The keys are the
// posix-style paths relative to this file: e.g.
// `./bundled/com/atproto/server/createAccount.json`. The values are the
// parsed JSON modules (because `.json` files have a JSON import attribute
// by default in Vite, even with `eager: true`).
const BUNDLED_MODULES = import.meta.glob('./bundled/**/*.json', {
  eager: true,
}) as Record<string, { default: unknown }>

let cachedCatalog: LexiconCatalog | null = null

/** Build (or return the cached) catalog of every bundled lexicon. Async to
 *  match the original disk-walking signature; callers stay the same. */
export async function loadBundledLexicons(): Promise<LexiconCatalog> {
  if (cachedCatalog) return cachedCatalog

  const docs = new Map<string, LexiconDoc>()
  for (const [path, mod] of Object.entries(BUNDLED_MODULES)) {
    const doc = assertLexiconDoc(mod.default, path)
    if (docs.has(doc.id)) {
      throw new Error(`duplicate lexicon id ${doc.id} (second copy at ${path})`)
    }
    docs.set(doc.id, doc)
  }

  cachedCatalog = makeCatalog(docs)
  return cachedCatalog
}

/** Build a catalog from an already-parsed map. Used by tests that want to
 *  inject a hand-rolled lexicon without touching the bundled set. */
export function makeCatalog(
  docs: Map<string, LexiconDoc>,
): LexiconCatalog {
  return {
    get: (nsid) => docs.get(nsid),
    resolve: (ref, contextNsid) => resolveRef(docs, ref, contextNsid),
    all: () => docs.values(),
  }
}

/** Test-only: clear the cache so a fresh `loadBundledLexicons()` reparses.
 *  Real callers should never need this — the bundled set is immutable. */
export function _resetCatalogCacheForTests(): void {
  cachedCatalog = null
}

function resolveRef(
  docs: Map<string, LexiconDoc>,
  ref: string,
  contextNsid?: string,
): LexUserType | undefined {
  let nsid: string
  let defName: string
  if (ref.startsWith('#')) {
    if (!contextNsid) return undefined
    nsid = contextNsid
    defName = ref.slice(1)
  } else if (ref.includes('#')) {
    const [n, d] = ref.split('#') as [string, string]
    nsid = n
    defName = d
  } else {
    nsid = ref
    defName = 'main'
  }
  const doc = docs.get(nsid)
  return doc?.defs[defName]
}

function assertLexiconDoc(value: unknown, path: string): LexiconDoc {
  if (!value || typeof value !== 'object') {
    throw new Error(`lexicon at ${path}: not an object`)
  }
  const obj = value as Record<string, unknown>
  if (obj.lexicon !== 1) {
    throw new Error(`lexicon at ${path}: expected "lexicon": 1`)
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    throw new Error(`lexicon at ${path}: missing string "id"`)
  }
  if (!obj.defs || typeof obj.defs !== 'object') {
    throw new Error(`lexicon at ${path}: missing "defs" object`)
  }
  // Sanity: the file's location should encode its NSID. Helps catch typos
  // at load time (lexicons/foo/bar/baz.json must have id "foo.bar.baz").
  const expected = expectedNsidFor(path)
  if (expected && obj.id !== expected) {
    throw new Error(
      `lexicon at ${path}: id "${obj.id}" does not match path-derived "${expected}"`,
    )
  }
  return obj as unknown as LexiconDoc
}

function expectedNsidFor(path: string): string | null {
  // `import.meta.glob` always yields posix-style paths, e.g.
  // `./bundled/com/atproto/server/createAccount.json`. Derive the NSID
  // from the segments after `bundled/`.
  const marker = '/bundled/'
  const idx = path.indexOf(marker)
  if (idx < 0) return null
  const rel = path.slice(idx + marker.length).replace(/\.json$/, '')
  return rel.split('/').join('.')
}
