import { useEffect, useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import {
  xrpcCall,
  XrpcError,
  xrpcUploadBlob,
  type BlobRef,
} from '~/lib/client/xrpc'
import { getSession } from '~/lib/client/session'
import {
  POST_MAX_BYTES,
  POST_MAX_GRAPHEMES,
  validatePostText,
} from '~/lib/client/postLimits'

// One-field "what's on your mind", optionally with up to 4 attached images.
// POSTs an `app.bsky.feed.post` record via com.atproto.repo.createRecord and
// bounces to /app/feed on success.
//
// Image flow:
//   1. The user picks 1–4 images via <input type="file" multiple>.
//   2. On submit, each image is POSTed to com.atproto.repo.uploadBlob and
//      returns a {$type:'blob', ref:{$link}, mimeType, size} ref.
//   3. The record is created with an embed.images union variant whose
//      `images[].image` field is that blob ref.
//
// We cap each image at 1 MB on the client. The server-side uploadBlob handler
// will accept up to 5 MB, but the app.bsky.embed.images lexicon's
// `image.maxSize` is 1_000_000 — and real Bluesky compresses to ~1 MB before
// upload. Keeping the cap symmetric here means the record will validate.

type CreateRecordResponse = { uri: string; cid: string }

const IMAGE_MAX_BYTES = 1_000_000 // matches app.bsky.embed.images image.maxSize
const IMAGE_MAX_COUNT = 4 // matches app.bsky.embed.images images.maxLength
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp']

type PickedImage = {
  /** Stable id so React keys survive reordering / removal. */
  id: string
  file: File
  alt: string
  /** `URL.createObjectURL`'d thumbnail src; revoked on unmount/remove. */
  previewUrl: string
  /** Per-image progress state during submit. */
  status: 'idle' | 'uploading' | 'uploaded' | 'error'
  errorMessage?: string
  /** Set once the bytes have been uploaded; lets a retry skip the re-upload. */
  uploadedBlob?: BlobRef
}

function nextId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function ComposeForm() {
  const router = useRouter()
  const [text, setText] = useState('')
  const [images, setImages] = useState<PickedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const validation = useMemo(() => validatePostText(text), [text])
  const overGraphemes = validation.graphemes > POST_MAX_GRAPHEMES
  const overBytes = validation.bytes > POST_MAX_BYTES

  // An empty post is allowed by the lexicon only if there's an embed.
  const textIsRequired = images.length === 0
  const textOk = textIsRequired
    ? validation.ok
    : validation.graphemes <= POST_MAX_GRAPHEMES && validation.bytes <= POST_MAX_BYTES

  // Revoke object URLs when the component unmounts so we don't leak. Per-image
  // revocation on remove is handled inline below.
  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.previewUrl)
    }
    // We intentionally don't depend on `images` — the cleanup runs only on
    // unmount, and per-image revocation happens at the remove call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleFiles(fileList: FileList | null) {
    if (!fileList) return
    setError(null)
    const picked: PickedImage[] = []
    const errors: string[] = []
    const remainingSlots = IMAGE_MAX_COUNT - images.length
    const files = Array.from(fileList).slice(0, remainingSlots)
    for (const file of files) {
      if (!ACCEPTED_MIME.includes(file.type)) {
        errors.push(`${file.name}: unsupported type ${file.type || '(unknown)'}`)
        continue
      }
      if (file.size > IMAGE_MAX_BYTES) {
        errors.push(`${file.name}: ${(file.size / 1024).toFixed(0)} KB exceeds 1 MB cap`)
        continue
      }
      picked.push({
        id: nextId(),
        file,
        alt: '',
        previewUrl: URL.createObjectURL(file),
        status: 'idle',
      })
    }
    if (fileList.length > remainingSlots) {
      errors.push(`Only ${IMAGE_MAX_COUNT} images per post; extras were dropped.`)
    }
    if (errors.length > 0) setError(errors.join(' '))
    if (picked.length > 0) setImages((prev) => [...prev, ...picked])
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const target = prev.find((p) => p.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  function setAlt(id: string, alt: string) {
    setImages((prev) => prev.map((p) => (p.id === id ? { ...p, alt } : p)))
  }

  function updateStatus(
    id: string,
    patch: Partial<Pick<PickedImage, 'status' | 'errorMessage'>>,
  ) {
    setImages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (textIsRequired && !validation.ok) {
      setError(validation.reason)
      return
    }
    if (!textOk) {
      setError(validation.reason ?? 'Invalid post text.')
      return
    }
    const session = getSession()
    if (!session) {
      setError('Not logged in.')
      return
    }

    setBusy(true)
    try {
      // Upload each image sequentially. We could parallelize, but for the
      // teaching client one-at-a-time keeps the network panel readable.
      // Each blob upload is independent; if one fails we abort the submit but
      // leave already-uploaded blob refs in component state so a retry only
      // re-uploads the ones that failed.
      const blobRefs: Array<{ image: PickedImage; blob: BlobRef }> = []
      for (const image of images) {
        if (image.status === 'uploaded' && image.uploadedBlob) {
          blobRefs.push({ image, blob: image.uploadedBlob })
          continue
        }
        updateStatus(image.id, { status: 'uploading', errorMessage: undefined })
        try {
          const bytes = new Uint8Array(await image.file.arrayBuffer())
          const blob = await xrpcUploadBlob({
            bytes,
            mimeType: image.file.type,
            auth: session,
          })
          // Stash the uploaded blob on the image so a partial-failure retry
          // doesn't re-upload successes.
          setImages((prev) =>
            prev.map((p) =>
              p.id === image.id
                ? { ...p, status: 'uploaded', uploadedBlob: blob }
                : p,
            ),
          )
          blobRefs.push({ image, blob })
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'upload failed'
          updateStatus(image.id, { status: 'error', errorMessage: message })
          if (err instanceof XrpcError && err.errorCode === 'ExpiredToken') {
            await router.navigate({ to: '/app' })
            router.invalidate()
            return
          }
          throw new Error(`Image "${image.file.name}" failed: ${message}`)
        }
      }

      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
      }
      if (blobRefs.length > 0) {
        record.embed = {
          $type: 'app.bsky.embed.images',
          images: blobRefs.map(({ image, blob }) => ({
            image: blob,
            alt: image.alt,
          })),
        }
      }

      await xrpcCall<CreateRecordResponse>('com.atproto.repo.createRecord', {
        auth: true,
        input: {
          repo: session.did,
          collection: 'app.bsky.feed.post',
          record,
        },
      })
      // Revoke object URLs before navigating away.
      for (const img of images) URL.revokeObjectURL(img.previewUrl)
      await router.navigate({ to: '/app/feed' })
      router.invalidate()
    } catch (err: unknown) {
      if (err instanceof XrpcError) {
        if (err.errorCode === 'ExpiredToken') {
          await router.navigate({ to: '/app' })
          router.invalidate()
          return
        }
        setError(err.message || 'Could not create post.')
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('Could not create post.')
      }
    } finally {
      setBusy(false)
    }
  }

  const slotsLeft = IMAGE_MAX_COUNT - images.length
  // A post must have text OR at least one image. The button stays disabled
  // until one of those is true.
  const submitDisabled =
    busy || overGraphemes || overBytes || (textIsRequired ? !validation.ok : false)

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={images.length > 0 ? 'Say something about the image(s)…' : "What's on your mind?"}
        rows={6}
        className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]/60"
      />
      <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
        <span className="font-mono">
          <span className={overGraphemes ? 'text-red-400' : ''}>
            {validation.graphemes}
          </span>
          {' / '}
          {POST_MAX_GRAPHEMES} graphemes
          <span className="mx-2">·</span>
          <span className={overBytes ? 'text-red-400' : ''}>
            {validation.bytes}
          </span>
          {' / '}
          {POST_MAX_BYTES} bytes
        </span>
      </div>

      {/* Image picker. Hidden file input + visible button so we can style. */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]/60 ${
              slotsLeft <= 0 ? 'pointer-events-none opacity-40' : ''
            }`}
          >
            <span>+ Image</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={slotsLeft <= 0 || busy}
              onChange={(e) => {
                handleFiles(e.target.files)
                // Reset so re-picking the same file fires onChange.
                e.target.value = ''
              }}
              className="hidden"
            />
          </label>
          <span className="text-xs text-[var(--color-fg-muted)]">
            {images.length}/{IMAGE_MAX_COUNT} images · max 1 MB each (jpeg, png, webp)
          </span>
        </div>

        {images.length > 0 ? (
          <div className="space-y-2">
            {images.map((img) => (
              <div
                key={img.id}
                className="flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
              >
                <div className="relative shrink-0">
                  <img
                    src={img.previewUrl}
                    alt=""
                    width={80}
                    height={80}
                    className="h-20 w-20 rounded object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    disabled={busy}
                    aria-label={`Remove ${img.file.name}`}
                    className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-white hover:bg-black disabled:opacity-50"
                  >
                    ×
                  </button>
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <input
                    type="text"
                    value={img.alt}
                    onChange={(e) => setAlt(img.id, e.target.value)}
                    placeholder="Alt text (describe the image for screen readers)"
                    maxLength={1000}
                    disabled={busy}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]/60"
                  />
                  <div className="flex items-center justify-between text-[10px] text-[var(--color-fg-muted)]">
                    <span className="truncate font-mono" title={img.file.name}>
                      {img.file.name} · {(img.file.size / 1024).toFixed(0)} KB
                    </span>
                    <span
                      className={
                        img.status === 'error'
                          ? 'text-red-400'
                          : img.status === 'uploaded'
                          ? 'text-green-400'
                          : ''
                      }
                    >
                      {img.status === 'idle' && 'ready'}
                      {img.status === 'uploading' && 'uploading…'}
                      {img.status === 'uploaded' && 'uploaded'}
                      {img.status === 'error' && (img.errorMessage ?? 'error')}
                    </span>
                  </div>
                  {img.alt.trim() === '' ? (
                    <p className="text-[10px] text-yellow-500/80">
                      No alt text — please add one for screen reader users.
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitDisabled}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-bg)] hover:bg-[var(--color-accent)]/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </form>
  )
}
