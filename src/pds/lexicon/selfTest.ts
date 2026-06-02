// Sanity check for the lexicon module — exercised by running:
//
//   pnpm tsx -e "import('./src/pds/lexicon/selfTest').then(m => m.runLexiconSelfTest())"
//
// Loads the catalog, compiles `app.bsky.feed.post`, and runs three cases:
// good post, missing `text`, over-graphemes. The good case must succeed; the
// other two must throw `ValidationError`. Logs progress + a final summary.

import {
  ValidationError,
  compileSchema,
  loadBundledLexicons,
} from './index'

export async function runLexiconSelfTest(): Promise<void> {
  const log = (msg: string) => console.log(`[lex-selftest] ${msg}`)

  log('loading bundled catalog...')
  const catalog = await loadBundledLexicons()
  const docs = [...catalog.all()]
  log(`loaded ${docs.length} lexicons`)

  const postDoc = catalog.get('app.bsky.feed.post')
  if (!postDoc) throw new Error('app.bsky.feed.post missing from catalog')
  const main = postDoc.defs.main
  if (!main || main.type !== 'record') {
    throw new Error('app.bsky.feed.post main def is not a record')
  }

  log('compiling app.bsky.feed.post record schema...')
  const validate = compileSchema(main.record, catalog, 'app.bsky.feed.post')

  // Case 1: well-formed post.
  const good = {
    $type: 'app.bsky.feed.post',
    text: 'hello, atmosphere',
    createdAt: '2026-06-02T17:00:00.000Z',
  }
  const out = validate(good)
  if (
    !out ||
    typeof out !== 'object' ||
    (out as { text?: unknown }).text !== 'hello, atmosphere'
  ) {
    throw new Error('valid post did not round-trip')
  }
  log('OK: valid post accepted')

  // Case 2: missing required `text`.
  expectThrow(
    'missing text',
    () =>
      validate({
        $type: 'app.bsky.feed.post',
        createdAt: '2026-06-02T17:00:00.000Z',
      }),
    'missing required property "text"',
  )
  log('OK: missing text rejected')

  // Case 3: over the 300-grapheme limit. We use ASCII so byte length ≈ char
  // count; 301 'a' is both 301 bytes and 301 graphemes.
  expectThrow(
    'over maxGraphemes',
    () =>
      validate({
        $type: 'app.bsky.feed.post',
        text: 'a'.repeat(301),
        createdAt: '2026-06-02T17:00:00.000Z',
      }),
    'maxGraphemes',
  )
  log('OK: over-length post rejected')

  // Bonus: a 12-codepoint, 1-grapheme emoji should NOT trip maxGraphemes=300.
  // Family emoji: man + ZWJ + woman + ZWJ + girl + ZWJ + boy = 7 code points,
  // surrogate-doubled to 11 UTF-16 units — and 1 grapheme. Useful to confirm
  // Intl.Segmenter is doing the right thing.
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
  validate({
    $type: 'app.bsky.feed.post',
    text: family,
    createdAt: '2026-06-02T17:00:00.000Z',
  })
  log(`OK: 1-grapheme emoji (${[...family].length} codepoints) accepted`)

  log('all self-tests passed')
}

function expectThrow(
  label: string,
  fn: () => unknown,
  substring: string,
): void {
  let threw: unknown = null
  try {
    fn()
  } catch (err) {
    threw = err
  }
  if (!threw) {
    throw new Error(`self-test "${label}" expected throw, got success`)
  }
  if (!(threw instanceof ValidationError)) {
    throw new Error(
      `self-test "${label}" threw non-ValidationError: ${String(threw)}`,
    )
  }
  if (!threw.message.includes(substring)) {
    throw new Error(
      `self-test "${label}" expected message to contain "${substring}", got "${threw.message}"`,
    )
  }
}
