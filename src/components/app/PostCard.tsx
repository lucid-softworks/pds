import { relativeTime } from '~/lib/client/relativeTime'

// One row in /app/feed. Renders:
//   - the post text (whitespace-preserved so newlines from the textarea
//     survive — but no rich-text facet rendering, that's an AppView concern),
//   - any image attachments (embed.images variant) in a responsive grid,
//   - a relative-time stamp,
//   - the at:// URI in a selectable <code> block.
//
// We deliberately don't try to link the URI anywhere yet. The PDS has no
// canonical "view a single post" page — that would require a getRecord-shaped
// route on this client, which the chapter calls out as a follow-up.
//
// For non-image embed variants (record-embeds, external link cards, video)
// we render a small monochrome "unknown embed: <$type>" badge. Rendering
// them properly is an AppView concern: record-embeds need cross-account
// getRecord fetches and a recursive renderer, external embeds need card
// scraping or a stored thumbnail blob, and video needs a player + transcoded
// variants. None of that fits a teaching PDS client.

export type PostRecord = {
  uri: string
  cid: string
  value: {
    $type?: string
    text?: string
    createdAt?: string
    embed?: PostEmbed
  }
}

type ImageBlob = {
  $type?: 'blob'
  ref?: { $link?: string }
  mimeType?: string
  size?: number
}

type ImagesEmbed = {
  $type: 'app.bsky.embed.images'
  images?: Array<{
    image?: ImageBlob
    alt?: string
    aspectRatio?: { width?: number; height?: number }
  }>
}

type UnknownEmbed = { $type?: string }

export type PostEmbed = ImagesEmbed | UnknownEmbed

// Extract the DID from an at:// URI: at://did:plc:foo/coll/rkey → did:plc:foo.
function ownerDidFromUri(uri: string): string | null {
  if (!uri.startsWith('at://')) return null
  const rest = uri.slice('at://'.length)
  const slash = rest.indexOf('/')
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  return authority || null
}

function blobUrl(did: string, cid: string): string {
  const u = new URLSearchParams({ did, cid })
  return `/xrpc/com.atproto.sync.getBlob?${u.toString()}`
}

// Tailwind's `grid-cols-N` classes need to be statically present in the
// markup for the JIT to pick them up; we map count → class explicitly.
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2',
}

function ImagesGrid({
  embed,
  ownerDid,
}: {
  embed: ImagesEmbed
  ownerDid: string
}) {
  const items = (embed.images ?? []).filter(
    (i): i is { image: ImageBlob; alt?: string } =>
      !!i && typeof i.image === 'object',
  )
  if (items.length === 0) return null
  const cols = GRID_COLS[Math.min(items.length, 4)] ?? 'grid-cols-2'
  return (
    <div className={`mt-3 grid gap-2 ${cols}`}>
      {items.map((item, idx) => {
        const link = item.image?.ref?.$link
        if (!link) return null
        return (
          <img
            // eslint-disable-next-line react/no-array-index-key
            key={`${link}-${idx}`}
            src={blobUrl(ownerDid, link)}
            alt={item.alt ?? ''}
            loading="lazy"
            className="aspect-square w-full rounded-md border border-[var(--color-border)] object-cover"
          />
        )
      })}
    </div>
  )
}

function UnknownEmbedBadge({ $type }: { $type: string | undefined }) {
  return (
    <p className="mt-3 inline-block rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[10px] text-[var(--color-fg-muted)]">
      unknown embed: {$type ?? '(no $type)'}
    </p>
  )
}

export function PostCard({ post }: { post: PostRecord }) {
  const text = post.value.text ?? ''
  const createdAt = post.value.createdAt
  const embed = post.value.embed
  const ownerDid = ownerDidFromUri(post.uri)

  return (
    <article className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="whitespace-pre-wrap break-words text-[var(--color-fg)]">
        {text || (
          <span className="italic text-[var(--color-fg-muted)]">(empty post)</span>
        )}
      </p>
      {embed && embed.$type === 'app.bsky.embed.images' && ownerDid ? (
        <ImagesGrid embed={embed as ImagesEmbed} ownerDid={ownerDid} />
      ) : embed ? (
        <UnknownEmbedBadge $type={embed.$type} />
      ) : null}
      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-fg-muted)]">
        <time
          dateTime={createdAt ?? ''}
          title={createdAt ?? 'unknown'}
        >
          {createdAt ? relativeTime(createdAt) : 'unknown time'}
        </time>
        <code className="font-mono text-[var(--color-fg-muted)] select-all break-all">
          {post.uri}
        </code>
      </footer>
    </article>
  )
}
