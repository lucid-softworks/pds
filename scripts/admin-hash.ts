// scripts/admin-hash.ts — print a scrypt hash for the PDS admin password.
//
// Usage:
//   pnpm admin:hash <password>
//   pnpm admin:hash               # prompts (no echo)
//
// Paste the resulting string into PDS_ADMIN_PASSWORD_HASH. The plaintext
// PDS_ADMIN_PASSWORD env var works in dev, but real deployments should hash
// once and keep only the digest on disk. See chapter 19.

import { hashPassword } from '~/pds/auth/password'

async function readFromStdin(): Promise<string> {
  process.stderr.write('admin password: ')
  return await new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
  })
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  const password = arg && arg.length > 0 ? arg : await readFromStdin()
  if (password.length < 8) {
    process.stderr.write('password must be at least 8 characters\n')
    process.exit(1)
  }
  const hash = await hashPassword(password)
  process.stdout.write(hash + '\n')
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`)
  process.exit(1)
})
