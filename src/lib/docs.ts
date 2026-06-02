import fs from 'node:fs/promises'
import path from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeShiki from '@shikijs/rehype'
import rehypeStringify from 'rehype-stringify'

const DOCS_DIR = path.join(process.cwd(), 'docs')

export type ChapterSummary = {
  slug: string
  number: number | null
  title: string
  blurb: string | null
}

export type Chapter = ChapterSummary & {
  html: string
  prev: ChapterSummary | null
  next: ChapterSummary | null
}

// Filenames follow the convention `NN-kebab-title.md` so the directory listing
// is also the reading order. README.md is treated as the table of contents and
// excluded from the chapter sequence.
const FILE_RE = /^(\d{2})-([a-z0-9-]+)\.md$/

let cache: ChapterSummary[] | null = null

export async function listChapters(): Promise<ChapterSummary[]> {
  if (cache) return cache
  const entries = await fs.readdir(DOCS_DIR)
  const summaries: ChapterSummary[] = []
  for (const entry of entries) {
    const match = entry.match(FILE_RE)
    if (!match) continue
    const number = Number.parseInt(match[1]!, 10)
    const slug = match[2]!
    const raw = await fs.readFile(path.join(DOCS_DIR, entry), 'utf8')
    const { title, blurb } = extractTitleAndBlurb(raw, slug)
    summaries.push({ slug, number, title, blurb })
  }
  summaries.sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  cache = summaries
  return summaries
}

export async function loadChapter(slug: string): Promise<Chapter | null> {
  const chapters = await listChapters()
  const index = chapters.findIndex((c) => c.slug === slug)
  if (index === -1) return null
  const summary = chapters[index]!
  const filename = `${String(summary.number).padStart(2, '0')}-${summary.slug}.md`
  const raw = await fs.readFile(path.join(DOCS_DIR, filename), 'utf8')
  const html = await renderMarkdown(raw)
  return {
    ...summary,
    html,
    prev: index > 0 ? chapters[index - 1]! : null,
    next: index < chapters.length - 1 ? chapters[index + 1]! : null,
  }
}

function extractTitleAndBlurb(
  raw: string,
  fallbackSlug: string,
): { title: string; blurb: string | null } {
  const lines = raw.split('\n')
  let title = fallbackSlug
  let blurb: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!title || title === fallbackSlug) {
      const h1 = line.match(/^#\s+(.+)$/)
      if (h1) {
        title = h1[1]!.trim()
        continue
      }
    }
    if (title !== fallbackSlug && line && !line.startsWith('#')) {
      blurb = line.replace(/[*_`]/g, '')
      break
    }
  }
  return { title, blurb }
}

let processor: ReturnType<typeof buildProcessor> | null = null

function buildProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: 'wrap',
      properties: { className: ['heading-anchor'] },
    })
    .use(rehypeShiki, {
      themes: { light: 'github-light', dark: 'tokyo-night' },
      defaultColor: 'dark',
    })
    .use(rehypeStringify)
}

async function renderMarkdown(raw: string): Promise<string> {
  if (!processor) processor = buildProcessor()
  const file = await processor.process(raw)
  return String(file)
}
