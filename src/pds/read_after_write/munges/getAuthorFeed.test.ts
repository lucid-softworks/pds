import { describe, expect, it } from 'vitest'
import { getAuthorFeedMunge, type AuthorFeedResponse } from './getAuthorFeed'
import type { LocalRecord, LocalRecords } from '../index'

const requester = 'did:plc:aliceee'
const requesterHandle = 'alice.test'

function makeLocalPost(rkey: string, text: string): LocalRecord {
  return {
    uri: `at://${requester}/app.bsky.feed.post/${rkey}`,
    cid: `bafy-${rkey}`,
    collection: 'app.bsky.feed.post',
    rkey,
    indexedAt: new Date(`2026-06-04T12:0${rkey}:00Z`).toISOString(),
    rev: `3lr${rkey}`,
    record: {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date(`2026-06-04T12:0${rkey}:00Z`).toISOString(),
    },
  }
}

const local = (posts: LocalRecord[]): LocalRecords => ({
  count: posts.length,
  profile: null,
  posts,
})

describe('getAuthorFeedMunge', () => {
  it('prepends local posts to the requester own feed (newest first)', async () => {
    const original: AuthorFeedResponse = {
      feed: [
        {
          post: {
            uri: `at://${requester}/app.bsky.feed.post/old1`,
            cid: 'bafy-old1',
            author: { did: requester, handle: requesterHandle },
            record: { $type: 'app.bsky.feed.post', text: 'old' },
            indexedAt: '2026-06-04T11:00:00Z',
          },
        },
      ],
    }
    const merged = await getAuthorFeedMunge({
      original,
      local: local([makeLocalPost('1', 'first'), makeLocalPost('2', 'second')]),
      requester,
      requesterHandle,
    })
    expect(merged.feed).toHaveLength(3)
    // Local posts come first; newer (rkey=2) ahead of older (rkey=1).
    expect(merged.feed[0]!.post.uri).toContain('.post/2')
    expect(merged.feed[1]!.post.uri).toContain('.post/1')
    expect(merged.feed[2]!.post.uri).toContain('.post/old1')
  })

  it('passes through when the feed is for a different author', async () => {
    const original: AuthorFeedResponse = {
      feed: [
        {
          post: {
            uri: 'at://did:plc:bobbbbb/app.bsky.feed.post/x',
            cid: 'bafy-x',
            author: { did: 'did:plc:bobbbbb', handle: 'bob.test' },
            record: { $type: 'app.bsky.feed.post', text: 'b' },
            indexedAt: '2026-06-04T11:00:00Z',
          },
        },
      ],
    }
    const merged = await getAuthorFeedMunge({
      original,
      local: local([makeLocalPost('1', 'first')]),
      requester,
      requesterHandle,
    })
    expect(merged.feed).toHaveLength(1) // unchanged
    expect(merged.feed[0]!.post.author.did).toBe('did:plc:bobbbbb')
  })

  it('dedupes when the AppView already has the local post', async () => {
    const dupeUri = `at://${requester}/app.bsky.feed.post/1`
    const original: AuthorFeedResponse = {
      feed: [
        {
          post: {
            uri: dupeUri,
            cid: 'bafy-1',
            author: { did: requester, handle: requesterHandle },
            record: { $type: 'app.bsky.feed.post', text: 'first' },
            indexedAt: '2026-06-04T12:01:00Z',
          },
        },
      ],
    }
    const merged = await getAuthorFeedMunge({
      original,
      local: local([makeLocalPost('1', 'first')]),
      requester,
      requesterHandle,
    })
    expect(merged.feed).toHaveLength(1)
  })

  it('uses the requester DID+handle when feed is empty', async () => {
    const original: AuthorFeedResponse = { feed: [] }
    const merged = await getAuthorFeedMunge({
      original,
      local: local([makeLocalPost('1', 'hi')]),
      requester,
      requesterHandle,
    })
    expect(merged.feed).toHaveLength(1)
    expect(merged.feed[0]!.post.author.did).toBe(requester)
    expect(merged.feed[0]!.post.author.handle).toBe(requesterHandle)
  })
})
