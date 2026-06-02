// Blob store backends.
//
// The store is a content-addressed bag of bytes: write `(creator, cid)` and
// the implementation hands back an opaque key it'll later use to read those
// bytes back. The metadata layer in the `blobs` table holds that key; the
// bytes themselves never round-trip through Postgres.
//
// Two backends ship here: a filesystem store for dev (bytes on disk under
// $BLOB_DIR), and an S3 stub for the production walkthrough in chapter 18.
//
// See chapter 15 — Blobs.

import { promises as fs, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import type { CID } from '~/pds/codec'
import { getConfig } from '~/lib/config'

export type BlobStore = {
  /** Write bytes to the store. Returns the storage key (opaque, used to read). */
  put(args: {
    cid: CID
    bytes: Uint8Array
    creator: string
    mimeType: string
  }): Promise<string>

  /** Read bytes by storage key. Returns null if absent. */
  get(storeKey: string): Promise<Uint8Array | null>

  /** Stream bytes for very large blobs. Returns null if absent. */
  getStream(storeKey: string): Promise<ReadableStream<Uint8Array> | null>

  /** Delete bytes. Idempotent — missing keys are not an error. */
  delete(storeKey: string): Promise<void>
}

/** Filesystem-backed store. Bytes live at `<baseDir>/<creator-did>/<cid>.bin`.
 *  Suitable for dev and small single-node deployments. */
export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  async put(args: {
    cid: CID
    bytes: Uint8Array
    creator: string
    mimeType: string
  }): Promise<string> {
    const key = this.keyFor(args.creator, args.cid.toString())
    const abs = this.absolute(key)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    // `wx` would fail on retries; content-addressing means rewriting the same
    // bytes is always safe, so plain write is fine.
    await fs.writeFile(abs, args.bytes)
    return key
  }

  async get(storeKey: string): Promise<Uint8Array | null> {
    try {
      const buf = await fs.readFile(this.absolute(storeKey))
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async getStream(storeKey: string): Promise<ReadableStream<Uint8Array> | null> {
    const abs = this.absolute(storeKey)
    try {
      // stat to give callers a fast "not found" before opening the stream —
      // a missing file would surface as an 'error' event mid-stream, which is
      // awkward to handle once headers have flushed.
      await fs.stat(abs)
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
    // Node's Readable.toWeb gives us a Web ReadableStream over the file.
    return Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>
  }

  async delete(storeKey: string): Promise<void> {
    try {
      await fs.unlink(this.absolute(storeKey))
    } catch (err) {
      if (isNotFound(err)) return
      throw err
    }
  }

  private keyFor(creator: string, cid: string): string {
    // DIDs are safe filename characters; we keep the colons. The CID is base32
    // multibase, also safe.
    return `${creator}/${cid}.bin`
  }

  private absolute(storeKey: string): string {
    return path.join(this.baseDir, storeKey)
  }
}

/** S3-backed store. Not implemented in the teaching port — production would
 *  use `@aws-sdk/client-s3` with the same `<creator-did>/<cid>.bin` layout
 *  (content-addressing means the bucket needs no metadata DB of its own).
 *  Chapter 18 walks the production wiring. */
export class S3BlobStore implements BlobStore {
  async put(): Promise<string> {
    throw new Error('S3BlobStore not implemented in teaching port')
  }
  async get(): Promise<Uint8Array | null> {
    throw new Error('S3BlobStore not implemented in teaching port')
  }
  async getStream(): Promise<ReadableStream<Uint8Array> | null> {
    throw new Error('S3BlobStore not implemented in teaching port')
  }
  async delete(): Promise<void> {
    throw new Error('S3BlobStore not implemented in teaching port')
  }
}

let cached: BlobStore | null = null

/** Build the configured store. Defaults to filesystem under `./.blobs`. */
export function getBlobStore(): BlobStore {
  if (cached) return cached
  const cfg = getConfig()
  cached =
    cfg.blobStoreKind === 's3'
      ? new S3BlobStore()
      : new FilesystemBlobStore(path.resolve(cfg.blobStoreDir))
  return cached
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT'
}
