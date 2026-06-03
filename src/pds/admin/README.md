# `admin/` — Audit log for operator actions

Every mutation through the `com.atproto.admin.*` XRPC surface writes one
row to `admin_audit`, regardless of whether the action succeeded or
threw. That table is the only place the input the admin actually sent
survives — without it, "who did what when" on a takedown becomes a
prayer to your structured log retention.

We store the `params` payload as DAG-CBOR rather than JSON so
`Uint8Array` and `bigint` survive a round trip byte-faithfully — the
same codec MST blocks and firehose events use elsewhere in the repo.
The read side (`com.atproto.admin.getAuditLog`) decodes on the way out
and JSON-stringifies via a small adapter so the console operator sees
plain values.

## Files

- [`audit.ts`](./audit.ts) — the helpers and the
  `withAdminAudit(action, handler)` wrapper. Captures `actor`,
  `target` (DID, when applicable), `action`, `params` (CBOR),
  `succeeded`, `errorName`, `errorMsg`, and `createdAt`. Read side
  cursors on `(createdAt, id)` for stable pagination.

## What gets audited

Five **mutations** (all write rows, including failures):

- `updateAccountStatus`
- `updateAccountHandle`
- `updateAccountEmail`
- `sendEmail`
- `deleteAccount`

Two **reads** that **don't** write (a dashboard's auto-refresh would
otherwise flood the table):

- `getAccountInfo`
- `getAccountInfos`

The wrapper sits inside each handler, not in the dispatcher, because
some handlers (notably `getAuditLog` itself) shouldn't audit their own
reads. Adding a new mutation? Wrap it with `withAdminAudit('myAction',
handler)` and the row appears for free.

See **[Chapter 19 — Moderation](../../../docs/19-moderation.md)**.
