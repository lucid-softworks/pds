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
  /** Plain-text body. Required — every client renders it as the
   *  fallback when HTML rendering is disabled or unavailable. */
  body: string
  /** Optional HTML body. When set, providers send a `multipart/alternative`
   *  with both `text` and `html`. Mail clients prefer the HTML. We keep
   *  `body` (text) as the source of truth and the template is built from
   *  it — see `renderTransactionalEmailHtml` in this file. */
  html?: string
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
  html?: string
  replyTo?: string
}

/** Body shape for Postmark's `/email` endpoint. */
type PostmarkBody = {
  From: string
  To: string
  Subject: string
  TextBody: string
  HtmlBody?: string
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
    if (msg.html) out.html = msg.html
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
    if (msg.html) out.HtmlBody = msg.html
    if (msg.replyTo) out.ReplyTo = msg.replyTo
    return out
  }
}

// ─── Templated HTML body ──────────────────────────────────────────────
//
// We render one HTML template — a simple, mostly-inline-CSS card with the
// PDS hostname in the header, a content block, and an optional code in
// a monospace box. Modern mail clients (Gmail, Apple Mail, Outlook 365)
// all handle inline-CSS + table layouts; we stick to the safe subset so
// dark-mode rendering doesn't fight us.
//
// Callers compose with `renderTransactionalEmailHtml({title, intro, code?,
// outro?, ctaLabel?, ctaUrl?})` and hand the result + the text version to
// `sendEmail`.

export type EmailTemplateInput = {
  /** Big heading at the top of the card. e.g. "Confirm your email". */
  title: string
  /** Lead paragraph above the code. */
  intro: string
  /** Optional monospace token block. Rendered in caps, letter-spaced. */
  code?: string
  /** Optional follow-up paragraph below the code. */
  outro?: string
  /** Hostname rendered in the header strip ("wickwork.cafe"). Pass
   *  `cfg.hostname` from the caller; we don't import config here so this
   *  module stays test-friendly. */
  brand: string
}

export function renderTransactionalEmailHtml(input: EmailTemplateInput): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&': return '&amp;'
        case '<': return '&lt;'
        case '>': return '&gt;'
        case '"': return '&quot;'
        default: return '&#39;'
      }
    })
  const codeBlock = input.code
    ? `
      <div style="margin:24px 0;padding:18px 12px;border-radius:8px;background:#1c2026;text-align:center;font-family:ui-monospace,SFMono-Regular,'JetBrains Mono',Menlo,monospace;font-size:22px;font-weight:600;color:#7aa2f7;letter-spacing:0.15em;border:1px solid #2a2f37;">
        ${esc(input.code)}
      </div>`
    : ''
  const outro = input.outro
    ? `<p style="margin:16px 0 0;color:#9aa3ad;font-size:14px;line-height:1.55;">${esc(input.outro)}</p>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0b0d10;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0b0d10;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:#15181d;border:1px solid #2a2f37;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:14px 20px;background:rgba(21,24,29,0.6);border-bottom:1px solid #2a2f37;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;">
              <span style="color:#7aa2f7;">pds</span><span style="color:#9aa3ad;">/${esc(input.brand)}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#e6e8eb;">${esc(input.title)}</h1>
              <p style="margin:0;color:#e6e8eb;font-size:15px;line-height:1.55;">${esc(input.intro)}</p>
              ${codeBlock}
              ${outro}
            </td>
          </tr>
          <tr>
            <td style="padding:14px 20px;background:rgba(21,24,29,0.6);border-top:1px solid #2a2f37;color:#9aa3ad;font-size:12px;">
              Sent by your PDS at <strong style="color:#bb9af7;">${esc(input.brand)}</strong>. If you didn't request this, you can ignore the message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
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
