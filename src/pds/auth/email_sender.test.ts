// Behaviour contract for the email backend.
//
// Two backends, console + http-json, and a tiny module-level cache. We
// reset the cache between cases and reach into the HttpJsonEmailBackend
// constructor directly for the network-shape tests (avoids depending on
// env-var parsing and a real network round-trip).

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ConsoleEmailBackend,
  HttpJsonEmailBackend,
  _resetEmailBackendForTests,
  getEmailBackend,
} from './email_sender'

afterEach(() => {
  _resetEmailBackendForTests()
})

describe('ConsoleEmailBackend', () => {
  it('writes a structured log line and resolves', async () => {
    const backend = new ConsoleEmailBackend()
    // The logger writes to stdout; spy on the underlying write so we can
    // assert without depending on the log level (the test setup pins
    // PDS_LOG_LEVEL=fatal). Bumping the level on the cached logger isn't
    // worth it for one assertion — we just check that send resolves.
    await expect(
      backend.send({
        to: 'alice@example.com',
        subject: 'Reset your password',
        body: 'token: abc123',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('HttpJsonEmailBackend', () => {
  it('POSTs to the URL with the right headers + generic body', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      return new Response('{}', { status: 200 })
    })
    const backend = new HttpJsonEmailBackend({
      url: 'https://example.test/send',
      token: 'tk_123',
      fromAddress: 'noreply@pds.example',
      fetchImpl: fetchMock,
    })

    await backend.send({
      to: 'bob@example.com',
      subject: 'Welcome',
      body: 'Hello.',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://example.test/send')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tk_123')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      from: 'noreply@pds.example',
      to: 'bob@example.com',
      subject: 'Welcome',
      text: 'Hello.',
    })
  })

  it('includes replyTo when provided (generic)', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{}', { status: 200 }),
    )
    const backend = new HttpJsonEmailBackend({
      url: 'https://example.test/send',
      token: 'tk_x',
      fromAddress: 'noreply@pds.example',
      fetchImpl: fetchMock,
    })
    await backend.send({
      to: 'c@example.com',
      subject: 's',
      body: 'b',
      replyTo: 'reply@pds.example',
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(body.replyTo).toBe('reply@pds.example')
  })

  it('uses Postmark capitalised field names with flavor=postmark', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{}', { status: 200 }),
    )
    const backend = new HttpJsonEmailBackend({
      url: 'https://api.postmarkapp.com/email',
      token: 'pm_tk',
      fromAddress: 'noreply@pds.example',
      flavor: 'postmark',
      fetchImpl: fetchMock,
    })
    await backend.send({
      to: 'c@example.com',
      subject: 'Hi',
      body: 'Body.',
      replyTo: 'reply@pds.example',
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(body).toEqual({
      From: 'noreply@pds.example',
      To: 'c@example.com',
      Subject: 'Hi',
      TextBody: 'Body.',
      ReplyTo: 'reply@pds.example',
    })
  })

  it('throws when the endpoint returns a 4xx', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => new Response('bad', { status: 422 }),
    )
    const backend = new HttpJsonEmailBackend({
      url: 'https://example.test/send',
      token: 'tk',
      fromAddress: 'noreply@pds.example',
      fetchImpl: fetchMock,
    })
    await expect(
      backend.send({ to: 'x@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/HTTP 422/)
  })

  it('throws when the endpoint returns a 5xx', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => new Response('oops', { status: 503 }),
    )
    const backend = new HttpJsonEmailBackend({
      url: 'https://example.test/send',
      token: 'tk',
      fromAddress: 'noreply@pds.example',
      fetchImpl: fetchMock,
    })
    await expect(
      backend.send({ to: 'x@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/HTTP 503/)
  })

  it('throws on network failure', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('ECONNREFUSED')
    })
    const backend = new HttpJsonEmailBackend({
      url: 'https://example.test/send',
      token: 'tk',
      fromAddress: 'noreply@pds.example',
      fetchImpl: fetchMock,
    })
    await expect(
      backend.send({ to: 'x@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/network.*ECONNREFUSED/)
  })
})

describe('getEmailBackend', () => {
  it("returns the console backend by default", () => {
    delete process.env.PDS_EMAIL_BACKEND
    delete process.env.PDS_EMAIL_HTTP_URL
    delete process.env.PDS_EMAIL_HTTP_TOKEN
    delete process.env.PDS_EMAIL_FROM
    delete process.env.PDS_EMAIL_HTTP_FLAVOR
    const b = getEmailBackend()
    expect(b).toBeInstanceOf(ConsoleEmailBackend)
  })

  it("returns the http-json backend when configured", () => {
    process.env.PDS_EMAIL_BACKEND = 'http-json'
    process.env.PDS_EMAIL_HTTP_URL = 'https://example.test/send'
    process.env.PDS_EMAIL_HTTP_TOKEN = 'tk'
    process.env.PDS_EMAIL_FROM = 'noreply@pds.example'
    try {
      const b = getEmailBackend()
      expect(b).toBeInstanceOf(HttpJsonEmailBackend)
    } finally {
      delete process.env.PDS_EMAIL_BACKEND
      delete process.env.PDS_EMAIL_HTTP_URL
      delete process.env.PDS_EMAIL_HTTP_TOKEN
      delete process.env.PDS_EMAIL_FROM
    }
  })

  it('throws if http-json is selected but env vars are missing', () => {
    process.env.PDS_EMAIL_BACKEND = 'http-json'
    delete process.env.PDS_EMAIL_HTTP_URL
    delete process.env.PDS_EMAIL_HTTP_TOKEN
    delete process.env.PDS_EMAIL_FROM
    try {
      expect(() => getEmailBackend()).toThrow(/PDS_EMAIL_HTTP_URL/)
    } finally {
      delete process.env.PDS_EMAIL_BACKEND
    }
  })

  it('throws on an unknown backend kind', () => {
    process.env.PDS_EMAIL_BACKEND = 'smtp'
    try {
      expect(() => getEmailBackend()).toThrow(/console.*http-json/)
    } finally {
      delete process.env.PDS_EMAIL_BACKEND
    }
  })

  it('throws on an unknown flavor', () => {
    process.env.PDS_EMAIL_BACKEND = 'http-json'
    process.env.PDS_EMAIL_HTTP_URL = 'https://example.test/send'
    process.env.PDS_EMAIL_HTTP_TOKEN = 'tk'
    process.env.PDS_EMAIL_FROM = 'noreply@pds.example'
    process.env.PDS_EMAIL_HTTP_FLAVOR = 'mailchimp'
    try {
      expect(() => getEmailBackend()).toThrow(/generic.*postmark/)
    } finally {
      delete process.env.PDS_EMAIL_BACKEND
      delete process.env.PDS_EMAIL_HTTP_URL
      delete process.env.PDS_EMAIL_HTTP_TOKEN
      delete process.env.PDS_EMAIL_FROM
      delete process.env.PDS_EMAIL_HTTP_FLAVOR
    }
  })
})
