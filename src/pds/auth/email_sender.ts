// Outbound email — a tiny pluggable backend.
//
// Two backends ship: a console one for dev (the original behaviour — a
// banner line in the terminal, so you can copy the token straight out) and
// an HTTP-JSON one that POSTs to a generic transactional-email endpoint
// (Resend / Postmark / Mailgun / a self-hosted relay). The operator picks
// at startup with `PDS_EMAIL_BACKEND`.
//
// Why no SMTP. Node has no native SMTP client and we have a hard "no new
// deps" rule for the teaching port — adding `nodemailer` would drag in a
// dozen transitive packages just for one delivery path. Operators who need
// SMTP wrap their server's SMTP relay behind a small HTTP shim and point
// `PDS_EMAIL_HTTP_URL` at it. Chapter 18 expands on this.
//
// Send-failure policy. The HTTP backend throws on 4xx/5xx/network error.
// Email-token handlers (`requestPasswordReset`, `requestEmailConfirmation`,
// …) already write the token to `email_tokens` *before* calling sendEmail,
// so a failed send doesn't leave the user wedged: they can request another
// email and the next try issues a fresh token (issuance drops the old row
// — see `src/pds/auth/email.ts`). The chapter calls this out.
//
// See chapter 13 — Authentication, and chapter 18 — Production.

import { getLogger } from '~/lib/logger'

const log = getLogger('email')

export type EmailMessage = {
  to: string
  subject: string
  body: string
  /** Optional reply-to override. Defaults to PDS_EMAIL_FROM. */
  replyTo?: string
}

export interface EmailBackend {
  send(msg: EmailMessage): Promise<void>
}

/** Dev backend: write a structured info log line. The body is inlined
 *  between two divider lines so a developer can scroll back and copy the
 *  token straight out of the terminal. */
export class ConsoleEmailBackend implements EmailBackend {
  async send(msg: EmailMessage): Promise<void> {
    const divider = '─'.repeat(60)
    const banner = [
      '',
      divider,
      `[email] to: ${msg.to}`,
      `[email] subject: ${msg.subject}`,
      ...(msg.replyTo ? [`[email] reply-to: ${msg.replyTo}`] : []),
      divider,
      msg.body,
      divider,
      '',
    ].join('\n')
    // One info-level line. Pretty-mode swallows the multi-line body into a
    // quoted field; JSON-mode shows it on the `body` key. Either way the
    // log shipper sees a single record.
    log.info('email-send', {
      backend: 'console',
      to: msg.to,
      subject: msg.subject,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      body: banner,
    })
  }
}

/** Body shape for the generic HTTP JSON flavor. */
type GenericBody = {
  from: string
  to: string
  subject: string
  text: string
  replyTo?: string
}

/** Body shape for Postmark's `/email` endpoint. */
type PostmarkBody = {
  From: string
  To: string
  Subject: string
  TextBody: string
  ReplyTo?: string
}

/** HTTP backend: POST the email to a generic JSON endpoint.
 *
 *  Compatible out of the box with Resend / Mailgun / a self-hosted relay
 *  (flavor 'generic') or Postmark (flavor 'postmark'). For providers with
 *  more exotic body shapes (e.g. SendGrid's nested `personalizations[]`),
 *  add a new flavor here — the public interface doesn't move.
 *
 *  Request:
 *
 *    POST <PDS_EMAIL_HTTP_URL>
 *    Authorization: Bearer <PDS_EMAIL_HTTP_TOKEN>
 *    Content-Type: application/json
 *    { from, to, subject, text, replyTo? }    (generic)
 *    { From, To, Subject, TextBody, ReplyTo? } (postmark)
 *
 *  A 10s `AbortController` timeout sits on the fetch. On non-2xx or network
 *  failure we log an error line and throw. Callers don't block the user
 *  flow on a send failure — see the module banner. */
export class HttpJsonEmailBackend implements EmailBackend {
  private readonly url: string
  private readonly token: string
  private readonly fromAddress: string
  private readonly flavor: 'generic' | 'postmark'
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: {
    url: string
    token: string
    fromAddress: string
    /** Body shape selector. Default 'generic'. */
    flavor?: 'generic' | 'postmark'
    /** Override for tests. Defaults to 10s. */
    timeoutMs?: number
    /** Override for tests. Defaults to globalThis.fetch. */
    fetchImpl?: typeof globalThis.fetch
  }) {
    this.url = opts.url
    this.token = opts.token
    this.fromAddress = opts.fromAddress
    this.flavor = opts.flavor ?? 'generic'
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  async send(msg: EmailMessage): Promise<void> {
    const body =
      this.flavor === 'postmark' ? this.postmarkBody(msg) : this.genericBody(msg)
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      log.error('email-send-network-error', {
        backend: 'http-json',
        flavor: this.flavor,
        to: msg.to,
        url: this.url,
        err: err instanceof Error ? err : new Error(String(err)),
      })
      throw new Error(
        `email send failed (network): ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      // Best-effort body capture for the log line. Don't block on a slow
      // read past a reasonable cap.
      const text = await res
        .text()
        .catch(() => '<unreadable>')
        .then((s) => s.slice(0, 500))
      log.error('email-send-http-error', {
        backend: 'http-json',
        flavor: this.flavor,
        to: msg.to,
        status: res.status,
        body: text,
      })
      throw new Error(`email send failed (HTTP ${res.status}): ${text}`)
    }

    log.info('email-send', {
      backend: 'http-json',
      flavor: this.flavor,
      to: msg.to,
      subject: msg.subject,
      status: res.status,
    })
  }

  private genericBody(msg: EmailMessage): GenericBody {
    const out: GenericBody = {
      from: this.fromAddress,
      to: msg.to,
      subject: msg.subject,
      text: msg.body,
    }
    if (msg.replyTo) out.replyTo = msg.replyTo
    return out
  }

  private postmarkBody(msg: EmailMessage): PostmarkBody {
    const out: PostmarkBody = {
      From: this.fromAddress,
      To: msg.to,
      Subject: msg.subject,
      TextBody: msg.body,
    }
    if (msg.replyTo) out.ReplyTo = msg.replyTo
    return out
  }
}

let cached: EmailBackend | null = null

/** Pick the backend once based on env. Validation is strict: if the
 *  operator opts into 'http-json' the URL / token / from-address must all
 *  be set, or we refuse to start. */
export function getEmailBackend(): EmailBackend {
  if (cached) return cached
  const kind = (process.env.PDS_EMAIL_BACKEND ?? 'console').toLowerCase()
  if (kind === 'console' || kind === '') {
    cached = new ConsoleEmailBackend()
    return cached
  }
  if (kind === 'http-json') {
    const url = process.env.PDS_EMAIL_HTTP_URL ?? ''
    const token = process.env.PDS_EMAIL_HTTP_TOKEN ?? ''
    const fromAddress = process.env.PDS_EMAIL_FROM ?? ''
    if (!url || !token || !fromAddress) {
      throw new Error(
        'PDS_EMAIL_BACKEND=http-json requires PDS_EMAIL_HTTP_URL, ' +
          'PDS_EMAIL_HTTP_TOKEN, and PDS_EMAIL_FROM to all be set.',
      )
    }
    const flavorRaw = (process.env.PDS_EMAIL_HTTP_FLAVOR ?? 'generic').toLowerCase()
    if (flavorRaw !== 'generic' && flavorRaw !== 'postmark') {
      throw new Error(
        `PDS_EMAIL_HTTP_FLAVOR must be 'generic' or 'postmark', got: ${flavorRaw}`,
      )
    }
    cached = new HttpJsonEmailBackend({
      url,
      token,
      fromAddress,
      flavor: flavorRaw,
    })
    return cached
  }
  throw new Error(
    `PDS_EMAIL_BACKEND must be 'console' or 'http-json', got: ${kind}`,
  )
}

/** Test-only: clear the cached backend so the next getEmailBackend() picks
 *  up changed env vars. */
export function _resetEmailBackendForTests(): void {
  cached = null
}

/** The signature that handlers call through. Resolves the backend lazily so
 *  tests can swap env vars + `_resetEmailBackendForTests()` between cases. */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  await getEmailBackend().send(msg)
}
