// scripts/pds-admin.ts — operator CLI for the PDS.
//
// Wraps the same orchestrators the XRPC admin handlers use. Lives outside
// the request lifecycle so an operator can move an account through its
// state machine even if the HTTP layer is down. Run with:
//
//   pnpm pds-admin <command> [args]
//
// Commands: create-account, list-accounts, show-account, takedown,
// deactivate, activate, delete, mint-invite, list-invites.
//
// Auth: this script talks to the database directly via the same
// ~/lib/db proxy the server uses, so DATABASE_URL must be set. No
// admin-password check — the operator already has DB credentials.

import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, inviteCodes } from '~/lib/db/schema'
import { createAccount } from '~/pds/account/create'
import { createOneInviteCode } from '~/pds/account/invites'
import { emitAccount, emitTombstone } from '~/pds/sequencer/sequence'

const COMMANDS = [
  'create-account',
  'list-accounts',
  'show-account',
  'takedown',
  'deactivate',
  'activate',
  'delete',
  'mint-invite',
  'list-invites',
  'help',
] as const

type Command = (typeof COMMANDS)[number]

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp()
    return
  }
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    console.error(`✗ unknown command: ${cmd}`)
    printHelp()
    process.exit(1)
  }
  switch (cmd as Command) {
    case 'create-account':
      return await cmdCreateAccount()
    case 'list-accounts':
      return await cmdListAccounts()
    case 'show-account':
      return await cmdShowAccount(rest)
    case 'takedown':
      return await cmdSetStatus(rest, 'takendown')
    case 'deactivate':
      return await cmdSetStatus(rest, 'deactivated')
    case 'activate':
      return await cmdSetStatus(rest, 'active')
    case 'delete':
      return await cmdDelete(rest)
    case 'mint-invite':
      return await cmdMintInvite(rest)
    case 'list-invites':
      return await cmdListInvites()
    case 'help':
      printHelp()
  }
}

function printHelp(): void {
  process.stdout.write(`
pds-admin <command> [args]

Account state machine:
  create-account                Interactive: prompts for handle/email/password
  list-accounts                 All accounts, one per line
  show-account <did>            Detail view
  takedown <did>                status → takendown (admin block)
  deactivate <did>              status → deactivated (reversible by user)
  activate <did>                status → active
  delete <did>                  status → deleted, emits #tombstone

Invites (gate via PDS_INVITE_REQUIRED=true):
  mint-invite [--for <did>] [--uses <n>]   Create one code
  list-invites                  All codes + their use counts

Examples:
  pnpm pds-admin create-account
  pnpm pds-admin takedown did:plc:abc123…
  pnpm pds-admin mint-invite --uses 5

Environment:
  DATABASE_URL          Postgres or pglite (default: pglite)
  PDS_PUBLIC_URL        Used by createAccount for the PLC service endpoint
  PDS_JWT_SECRET        Required by config loader; values don't affect CLI
`)
}

async function cmdCreateAccount(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const handle = await rl.question('handle (e.g. alice.test): ')
    const email = await rl.question('email: ')
    const password = await rl.question('password: ')
    const inviteCode = (await rl.question(
      'invite code (blank to skip): ',
    )).trim()
    const result = await createAccount({
      handle: handle.trim(),
      email: email.trim(),
      password,
      ...(inviteCode ? { inviteCode } : {}),
    })
    ok(`created ${result.handle} → ${result.did}`)
    info('access JWT (copy now, not stored):')
    process.stdout.write(`  ${result.accessJwt}\n`)
    info('refresh JWT:')
    process.stdout.write(`  ${result.refreshJwt}\n`)
  } finally {
    rl.close()
  }
}

async function cmdListAccounts(): Promise<void> {
  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .orderBy(accounts.createdAt)
  if (rows.length === 0) {
    info('no accounts')
    return
  }
  for (const row of rows) {
    const marker = statusGlyph(row.status)
    process.stdout.write(
      `${marker} ${row.handle.padEnd(28)} ${row.did}   ${row.email}\n`,
    )
  }
}

async function cmdShowAccount(args: string[]): Promise<void> {
  const did = requireDid(args[0])
  const row = (
    await db.select().from(accounts).where(eq(accounts.did, did)).limit(1)
  )[0]
  if (!row) {
    fail(`no account with did ${did}`)
    return
  }
  process.stdout.write(JSON.stringify(
    {
      did: row.did,
      handle: row.handle,
      email: row.email,
      status: row.status,
      emailConfirmedAt: row.emailConfirmedAt,
      migrationState: row.migrationState,
      createdAt: row.createdAt,
    },
    null,
    2,
  ) + '\n')
}

async function cmdSetStatus(
  args: string[],
  status: 'active' | 'takendown' | 'deactivated',
): Promise<void> {
  const did = requireDid(args[0])
  const row = (
    await db.select({ status: accounts.status }).from(accounts).where(eq(accounts.did, did)).limit(1)
  )[0]
  if (!row) {
    fail(`no account with did ${did}`)
    return
  }
  if (row.status === 'deleted') {
    fail(`account is deleted; transition rejected`)
    return
  }
  await db.update(accounts).set({ status }).where(eq(accounts.did, did))
  await emitAccount({
    did,
    active: status === 'active',
    ...(status === 'active' ? {} : { status }),
  })
  ok(`${did}: ${row.status} → ${status}`)
}

async function cmdDelete(args: string[]): Promise<void> {
  const did = requireDid(args[0])
  const row = (
    await db.select({ status: accounts.status }).from(accounts).where(eq(accounts.did, did)).limit(1)
  )[0]
  if (!row) {
    fail(`no account with did ${did}`)
    return
  }
  if (row.status === 'deleted') {
    info(`already deleted`)
    return
  }
  await db.update(accounts).set({ status: 'deleted' }).where(eq(accounts.did, did))
  await emitAccount({ did, active: false, status: 'deleted' })
  await emitTombstone({ did })
  ok(`${did}: marked deleted, tombstone emitted`)
}

async function cmdMintInvite(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      for: { type: 'string' },
      uses: { type: 'string', default: '1' },
    },
    allowPositionals: true,
  })
  const usesRemaining = Number.parseInt(parsed.values.uses ?? '1', 10)
  if (!Number.isFinite(usesRemaining) || usesRemaining < 1) {
    fail(`--uses must be a positive integer`)
    return
  }
  const result = await createOneInviteCode({
    createdBy: null,
    forAccount: parsed.values.for ?? null,
    usesRemaining,
  })
  ok(`code: ${result.code}`)
  info(`uses: ${result.usesRemaining}${parsed.values.for ? `   for: ${parsed.values.for}` : ''}`)
}

async function cmdListInvites(): Promise<void> {
  const rows = await db
    .select({
      code: inviteCodes.code,
      createdBy: inviteCodes.createdBy,
      forAccount: inviteCodes.forAccount,
      usesRemaining: inviteCodes.usesRemaining,
      usesTotal: inviteCodes.usesTotal,
      disabled: inviteCodes.disabled,
      createdAt: inviteCodes.createdAt,
    })
    .from(inviteCodes)
    .orderBy(inviteCodes.createdAt)
  if (rows.length === 0) {
    info('no invite codes')
    return
  }
  for (const row of rows) {
    const status = row.disabled ? '⊘' : row.usesRemaining > 0 ? '○' : '●'
    const target = row.forAccount ?? row.createdBy ?? 'open'
    process.stdout.write(
      `${status} ${row.code}   ${row.usesRemaining}/${row.usesRemaining + row.usesTotal} left   ${target}\n`,
    )
  }
}

function requireDid(value: string | undefined): string {
  if (!value || !value.startsWith('did:')) {
    fail(`expected a DID argument (did:plc:...)`)
    process.exit(1)
  }
  return value
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'active': return '●'
    case 'takendown': return '⊘'
    case 'deactivated': return '○'
    case 'deleted': return '×'
    default: return '?'
  }
}

function ok(msg: string): void {
  process.stdout.write(`✓ ${msg}\n`)
}
function info(msg: string): void {
  process.stdout.write(`  ${msg}\n`)
}
function fail(msg: string): void {
  process.stderr.write(`✗ ${msg}\n`)
}

main().then(() => process.exit(0)).catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n')
  }
  process.exit(1)
})
