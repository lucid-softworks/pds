// Outbound email shim.
//
// Dev-only: every "send" is a structured console log so you can copy the
// token straight out of the terminal during testing. A real transactional
// provider (SES, Postmark, Resend) lands in chapter 18 — that chapter will
// keep this function's signature and swap the body for an HTTP call.
//
// TODO(chapter 18): replace this implementation with SMTP / API delivery.

export async function sendEmail(args: {
  to: string
  subject: string
  body: string
}): Promise<void> {
  const divider = '─'.repeat(60)
  console.log(
    [
      '',
      divider,
      `[email] to: ${args.to}`,
      `[email] subject: ${args.subject}`,
      divider,
      args.body,
      divider,
      '',
    ].join('\n'),
  )
}
