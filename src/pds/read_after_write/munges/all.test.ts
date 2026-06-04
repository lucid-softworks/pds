// Unit tests for the read-after-write munges.
//
// Each munge is pure (input → input + local records → output) so the
// tests build `LocalRecords` literals without touching the DB. The
// integration of the rev-window query lives in `index.ts` and is
// covered indirectly by the proxy's behavior at runtime.

import { describe, expect, it } from 'vitest'
import type { LocalRecord, LocalRecords } from '../index'
import { getTimelineMunge, type TimelineResponse } from './getTimeline'
import { getProfileMunge, type ProfileResponse } from './getProfile'
import { getProfilesMunge, type ProfilesResponse } from './getProfiles'
import { getPostThreadMunge, type ThreadResponse } from './getPostThread'
import { getActorLikesMunge, type ActorLikesResponse } from './getActorLikes'

const requester = 'did:plc:aliceee'
const requesterHandle = 'alice.test'

function mkPost(rkey: string, opts: { replyTo?: string } = {}): LocalRecord {
  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text: `post ${rkey}`,
    createdAt: `2026-06-04T12:0${rkey}:00Z`,
  }
  if (opts.replyTo) {
    record.reply = {
      parent: { uri: opts.replyTo, cid: 'bafy-parent' },
      root: { uri: opts.replyTo, cid: 'bafy-parent' },
    }
  }
  return {
    uri: `at://${requester}/app.bsky.feed.post/${rkey}`,
    cid: `bafy-${rkey}`,
    collection: 'app.bsky.feed.post',
    rkey,
    indexedAt: `2026-06-04T12:0${rkey}:00Z`,
    rev: `3lr${rkey}`,
    record,
  }
}

function mkProfile(record: Record<string, unknown>): LocalRecord {
  return {
    uri: `at://${requester}/app.bsky.actor.profile/self`,
    cid: 'bafy-profile',
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
    indexedAt: '2026-06-04T12:00:00Z',
    rev: '3lrPROFILE',
    record: { $type: 'app.bsky.actor.profile', ...record },
  }
}

const wrap = (posts: LocalRecord[], profile: LocalRecord | null = null): LocalRecords => ({
  count: posts.length + (profile ? 1 : 0),
  profile,
  posts,
})

describe('getTimelineMunge', () => {
  it('inserts the requester local posts in indexedAt order (newest first)', async () => {
    const original: TimelineResponse = {
      feed: [
        {
          post: {
            uri: 'at://did:plc:friend/app.bsky.feed.post/x',
            cid: 'bafy-x',
            author: { did: 'did:plc:friend', handle: 'friend.test' },
            record: { $type: 'app.bsky.feed.post', text: 'friend' },
            indexedAt: '2026-06-04T11:30:00Z',
          },
        },
      ],
    }
    const merged = await getTimelineMunge({
      original,
      local: wrap([mkPost('2'), mkPost('1')]),
      requester,
      requesterHandle,
    })
    expect(merged.feed).toHaveLength(3)
    expect(merged.feed[0]!.post.uri).toContain('.post/2')
    expect(merged.feed[1]!.post.uri).toContain('.post/1')
    expect(merged.feed[2]!.post.uri).toContain('.post/x')
  })

  it('returns the original feed when local has no posts', async () => {
    const original: TimelineResponse = { feed: [] }
    const merged = await getTimelineMunge({
      original,
      local: wrap([]),
      requester,
      requesterHandle,
    })
    expect(merged).toBe(original)
  })
})

describe('getProfileMunge', () => {
  it('overlays the local profile record onto the requester own profile', async () => {
    const original: ProfileResponse = {
      did: requester,
      handle: requesterHandle,
      displayName: 'Old Name',
      description: 'Old bio',
    }
    const merged = await getProfileMunge({
      original,
      local: wrap(
        [],
        mkProfile({
          displayName: 'New Name',
          description: 'New bio',
          avatar: { ref: { $link: 'bafy-avatar' } },
        }),
      ),
      requester,
      requesterHandle,
    })
    expect(merged.displayName).toBe('New Name')
    expect(merged.description).toBe('New bio')
    expect(merged.avatar).toBe('bafy-avatar')
  })

  it("doesn't touch a profile that isn't the requester's", async () => {
    const original: ProfileResponse = {
      did: 'did:plc:other',
      handle: 'other.test',
      displayName: 'Other',
    }
    const merged = await getProfileMunge({
      original,
      local: wrap([], mkProfile({ displayName: 'New' })),
      requester,
      requesterHandle,
    })
    expect(merged.displayName).toBe('Other')
  })

  it('passes through when there is no local profile', async () => {
    const original: ProfileResponse = { did: requester, handle: requesterHandle }
    const merged = await getProfileMunge({
      original,
      local: wrap([]),
      requester,
      requesterHandle,
    })
    expect(merged).toBe(original)
  })
})

describe('getProfilesMunge', () => {
  it('overlays only the entry matching the requester', async () => {
    const original: ProfilesResponse = {
      profiles: [
        { did: 'did:plc:other', handle: 'other.test', displayName: 'O' },
        { did: requester, handle: requesterHandle, displayName: 'Old' },
      ],
    }
    const merged = await getProfilesMunge({
      original,
      local: wrap([], mkProfile({ displayName: 'New' })),
      requester,
      requesterHandle,
    })
    expect(merged.profiles[0]!.displayName).toBe('O')
    expect(merged.profiles[1]!.displayName).toBe('New')
  })
})

describe('getPostThreadMunge', () => {
  it("refreshes a node's post when its URI matches a local record", async () => {
    const uri = `at://${requester}/app.bsky.feed.post/root`
    const original: ThreadResponse = {
      thread: {
        $type: 'app.bsky.feed.defs#threadViewPost',
        post: {
          uri,
          cid: 'bafy-old',
          author: { did: requester, handle: requesterHandle },
          record: { $type: 'app.bsky.feed.post', text: 'old text' },
          indexedAt: '2026-06-04T11:00:00Z',
        },
      },
    }
    const localPost: LocalRecord = {
      ...mkPost('root'),
      uri,
      cid: 'bafy-new',
      record: { $type: 'app.bsky.feed.post', text: 'new text' },
    }
    const merged = await getPostThreadMunge({
      original,
      local: wrap([localPost]),
      requester,
      requesterHandle,
    })
    expect(merged.thread.post!.cid).toBe('bafy-new')
    expect(
      (merged.thread.post!.record as { text: string }).text,
    ).toBe('new text')
  })

  it('synthesizes new reply nodes from local replies to a parent in the tree', async () => {
    const parentUri = 'at://did:plc:friend/app.bsky.feed.post/parent'
    const original: ThreadResponse = {
      thread: {
        $type: 'app.bsky.feed.defs#threadViewPost',
        post: {
          uri: parentUri,
          cid: 'bafy-parent',
          author: { did: 'did:plc:friend', handle: 'friend.test' },
          record: { $type: 'app.bsky.feed.post', text: 'parent' },
          indexedAt: '2026-06-04T11:00:00Z',
        },
        replies: [],
      },
    }
    const merged = await getPostThreadMunge({
      original,
      local: wrap([mkPost('1', { replyTo: parentUri })]),
      requester,
      requesterHandle,
    })
    expect(merged.thread.replies).toHaveLength(1)
    expect(merged.thread.replies![0]!.post!.uri).toContain('.post/1')
  })
})

describe('getActorLikesMunge', () => {
  it("refreshes a feed entry when its post URI matches a local record (user liked their own edit)", async () => {
    const uri = `at://${requester}/app.bsky.feed.post/self`
    const original: ActorLikesResponse = {
      feed: [
        {
          post: {
            uri,
            cid: 'bafy-old',
            author: { did: requester, handle: requesterHandle },
            record: { $type: 'app.bsky.feed.post', text: 'old' },
            indexedAt: '2026-06-04T11:00:00Z',
          },
        },
      ],
    }
    const localPost: LocalRecord = {
      ...mkPost('self'),
      uri,
      cid: 'bafy-new',
      record: { $type: 'app.bsky.feed.post', text: 'new' },
    }
    const merged = await getActorLikesMunge({
      original,
      local: wrap([localPost]),
      requester,
      requesterHandle,
    })
    expect(merged.feed[0]!.post.cid).toBe('bafy-new')
  })

  it('passes through entries with no local match', async () => {
    const original: ActorLikesResponse = {
      feed: [
        {
          post: {
            uri: 'at://did:plc:other/app.bsky.feed.post/x',
            cid: 'bafy-x',
            author: { did: 'did:plc:other', handle: 'other.test' },
            record: { $type: 'app.bsky.feed.post', text: 'x' },
            indexedAt: '2026-06-04T11:00:00Z',
          },
        },
      ],
    }
    const merged = await getActorLikesMunge({
      original,
      local: wrap([mkPost('1')]),
      requester,
      requesterHandle,
    })
    expect(merged.feed[0]!.post.cid).toBe('bafy-x')
  })
})
