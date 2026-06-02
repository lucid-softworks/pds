// Lexicon catalog loader.
//
// Reads every bundled JSON file at startup, parses it into `LexiconDoc`, and
// exposes lookup + reference resolution. Parsing is intentionally trusting —
// the JSON files are checked into the repo, so a malformed one is a build bug,
// not a runtime threat. We do validate the top-level shape (lexicon == 1, id
// present) so the failure mode is obvious.

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { LexUserType, LexiconDoc } from './types'

export type LexiconCatalog = {
  get(nsid: string): LexiconDoc | undefined
  /** Resolve a ref like `foo.bar.baz#defname`, or `foo.bar.baz` (= main), or
   *  `#defname` (relative to `contextNsid`). Returns undefined if unknown. */
  resolve(ref: string, contextNsid?: string): LexUserType | undefined
  all(): Iterable<LexiconDoc>
}

const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'bundled')

/** Walk the bundled/ tree, parse every `.json` file. Caller-controlled —
 *  designed to be invoked once at startup. */
export async function loadBundledLexicons(): Promise<LexiconCatalog> {
  const files = await walk(BUNDLED_DIR)
  const docs = new Map<string, LexiconDoc>()

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const raw = await readFile(file, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`lexicon parse error in ${file}: ${(err as Error).message}`)
    }
    const doc = assertLexiconDoc(parsed, file)
    if (docs.has(doc.id)) {
      throw new Error(`duplicate lexicon id ${doc.id} (second copy at ${file})`)
    }
    docs.set(doc.id, doc)
  }

  return makeCatalog(docs)
}

/** Build a catalog from an already-parsed map. Useful for tests + non-Node
 *  embeddings (e.g. if we later inline lexicons via Vite glob imports). */
export function makeCatalog(
  docs: Map<string, LexiconDoc>,
): LexiconCatalog {
  return {
    get: (nsid) => docs.get(nsid),
    resolve: (ref, contextNsid) => resolveRef(docs, ref, contextNsid),
    all: () => docs.values(),
  }
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

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await walk(full)
      out.push(...nested)
    } else {
      out.push(full)
    }
  }
  return out
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
  // Sanity: the file's location should encode its NSID. Helps catch typos at
  // load time (lexicons/foo/bar/baz.json must have id "foo.bar.baz").
  const expected = expectedNsidFor(path)
  if (expected && obj.id !== expected) {
    throw new Error(
      `lexicon at ${path}: id "${obj.id}" does not match path-derived "${expected}"`,
    )
  }
  return obj as unknown as LexiconDoc
}

function expectedNsidFor(path: string): string | null {
  const marker = `${sep}bundled${sep}`
  const idx = path.indexOf(marker)
  if (idx < 0) return null
  const rel = path.slice(idx + marker.length).replace(/\.json$/, '')
  return rel.split(sep).join('.')
}
