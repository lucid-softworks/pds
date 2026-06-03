// Compose-form lexicon enforcement.
//
// `app.bsky.feed.post` caps text at:
//   - maxLength: 3000 (UTF-8 bytes — that's what the lexicon validator counts)
//   - maxGraphemes: 300 (user-perceived characters)
//
// We enforce both client-side so the user gets fast feedback. The server
// re-checks via the lexicon bridge on createRecord, so this is a UX layer,
// not a security boundary.
//
// Graphemes are tricky: an emoji-flag is two code points (1f1ef + 1f1f5) but
// one grapheme. `Intl.Segmenter` does the right thing where supported (every
// modern browser since 2022). When it isn't available we fall back to the
// code-point count via the spread iterator — close enough for ASCII, and the
// real-Bluesky lexicon validator does the same thing as a fallback.

export const POST_MAX_BYTES = 3000
export const POST_MAX_GRAPHEMES = 300

export function byteLength(text: string): number {
  // TextEncoder is standard in Node ≥ 11 and every modern browser.
  return new TextEncoder().encode(text).length
}

export function graphemeLength(text: string): number {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let count = 0
    for (const _ of segmenter.segment(text)) count++
    return count
  }
  // Code-point fallback. [...str] iterates by code point, not by code unit,
  // so a single non-BMP emoji counts as 1 (not 2 like .length would).
  return [...text].length
}

export type PostValidation = {
  ok: boolean
  bytes: number
  graphemes: number
  reason: string | null
}

export function validatePostText(text: string): PostValidation {
  const bytes = byteLength(text)
  const graphemes = graphemeLength(text)
  if (text.trim().length === 0) {
    return { ok: false, bytes, graphemes, reason: 'Post text cannot be empty.' }
  }
  if (bytes > POST_MAX_BYTES) {
    return {
      ok: false,
      bytes,
      graphemes,
      reason: `Post is too long — ${bytes} of ${POST_MAX_BYTES} bytes.`,
    }
  }
  if (graphemes > POST_MAX_GRAPHEMES) {
    return {
      ok: false,
      bytes,
      graphemes,
      reason: `Post is too long — ${graphemes} of ${POST_MAX_GRAPHEMES} characters.`,
    }
  }
  return { ok: true, bytes, graphemes, reason: null }
}
