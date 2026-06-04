// Version string surfaced via `GET /xrpc/_health` and (later) any other
// "what's running?" probe. Mirrors the reference PDS, which reads a
// single `version` field from its service config.
//
// Resolution order, cached on first call:
//   1. `PDS_VERSION` env var          — set by the deploy / build pipeline
//   2. `git rev-parse HEAD` (synchronous)
//                                      — works when the repo's .git tree is
//                                        present (our deploy.sh case)
//   3. `package.json` version         — last-resort floor
//   4. literal 'unknown'              — every other path failed
//
// Synchronous execSync is fine here because the call is one-shot and
// gated by a cache; subsequent calls return immediately.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let cached: string | undefined

export function getVersion(): string {
  if (cached !== undefined) return cached
  cached = resolveVersion()
  return cached
}

function resolveVersion(): string {
  if (process.env.PDS_VERSION) return process.env.PDS_VERSION
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    if (sha) return sha
  } catch {
    // not a git checkout — fall through
  }
  try {
    const pkgPath = resolve(process.cwd(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string
    }
    if (pkg.version) return pkg.version
  } catch {
    // no readable package.json — fall through
  }
  return 'unknown'
}
