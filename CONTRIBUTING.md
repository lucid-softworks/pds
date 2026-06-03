# Contributing

This is a teaching project. The point isn't velocity — it's that each change
makes the codebase *easier to read*. A few guidelines.

## Before you write code

- Read the chapter that covers the subsystem you're touching.
  [`docs/`](./docs/README.md) is the index.
- Look at the README in the relevant `src/pds/<subsystem>/` directory.
- Skim the existing handler / module for the conventions.

## Adding an XRPC endpoint

1. Drop a handler module at `src/pds/xrpc/handlers/<nsid>.ts`. Copy the
   shape of [`com.atproto.server.createAccount.ts`](./src/pds/xrpc/handlers/com.atproto.server.createAccount.ts):
   exports `nsid` (string) and `def` (`HandlerDef`).
2. Register it in [`src/pds/xrpc/handlers/index.ts`](./src/pds/xrpc/handlers/index.ts).
   One import line + one `.register(nsid, def)` chain entry.
3. Add a bundled lexicon at `src/pds/lexicon/bundled/<nsid-as-path>.json`
   if the validator should know about it. (The validator isn't wired into
   the dispatcher yet, but having the schema present means it'll get
   coverage when we flip the switch.)
4. If the endpoint has a new tutorial-worthy concept, extend the relevant
   chapter or write a new one.

## Adding a database table

1. Create a new schema file at `src/lib/db/schema/<name>.ts`. Look at
   [`accounts.ts`](./src/lib/db/schema/accounts.ts) for the conventions.
2. Add `export * from './<name>'` to
   [`src/lib/db/schema/index.ts`](./src/lib/db/schema/index.ts).
3. Write a matching SQL migration as `drizzle/NNNN_<name>.sql`. Pick the
   next sequential number.
4. Run `pnpm db:migrate` to apply locally.

> ⚠️ Don't edit existing migration files once they've been applied
> anywhere. Add columns and tables via *new* numbered migrations.

## Adding a chapter

1. Create `docs/NN-<slug>.md`. The number prefix sets reading order; the
   docs UI sorts by it automatically.
2. Match the existing chapter voice — tight, technical, no fluff. Read
   chapter 12 or chapter 5 for examples.
3. Use ⚠️ callouts for divergences from the reference Bluesky PDS, 📖
   callouts for deeper-dive context.
4. Each chapter ends with an "Up next" arrow:
   `← [N-1 — …](./N-1-…) · → [N+1 — …](./N+1-…)`.
5. Add the chapter to `docs/README.md`'s table of contents.

## Running locally

```bash
pnpm install
cp .env.example .env       # set PDS_JWT_SECRET to 64 random hex chars
pnpm db:migrate
pnpm dev                   # docs + XRPC at http://localhost:3000
```

End-to-end smoke test:

```bash
scripts/demo.sh
```

## Verifying changes

- `pnpm typecheck` — must stay clean.
- `pnpm vite build` — must produce a server bundle.
- `pnpm test` — must stay green. New subsystems get test files in
  `src/pds/<subsystem>/*.test.ts`; cross-subsystem flows go in
  `tests/integration/`.
- `scripts/demo.sh` — must succeed end-to-end (it runs against a live
  `pnpm dev`). If your change adds a new endpoint, add a step to the demo.

CI runs all four on every push via `.github/workflows/ci.yml`.

## Writing tests

The harness is vitest with `pool: 'forks'` so each test file gets a worker.
For tests that touch the database:

```ts
import { setupTestDbEnv, migrateProcessDb } from '../../tests/db'

// Call BEFORE any import of ~/lib/db — sets DATABASE_URL to a unique
// pglite tmp path so each test file gets a fresh DB.
setupTestDbEnv()

import { beforeAll, ... } from 'vitest'
beforeAll(async () => {
  await migrateProcessDb()
})
```

Read `tests/integration/account-lifecycle.test.ts` for the integration-test
shape. Unit tests for a pure subsystem (codec, mst, car, jwt, etc.) don't
need the DB at all and can skip the setup.

## Commits

Conventional Commits. Examples from the existing history:

- `feat(repo): full Merkle Search Tree implementation`
- `feat(auth): app passwords`
- `docs(chapter-12): full account-creation walkthrough`
- `fix: adapt to TanStack Start ≥ 1.166 API churn`
- `chore: pin pnpm lockfile`

The first line is what shows up in `git log --oneline`; make it count.

## What this project deliberately doesn't do

These decisions are reversible — but the reasoning matters before you flip
any of them:

- **Use `@atproto/*` packages.** Re-implementing the MST, CAR, and lexicon
  validator from scratch is *the entire teaching value* of this codebase.
  Pulling in the official packages would skip the lessons.
- **Codegen XRPC types from lexicons.** The lexicon validator is runtime
  by design — see chapter 9. Codegen is faster, less readable.
- **Codegen Drizzle migrations.** Hand-written SQL is what the reader
  audits. The schema and migration are decoupled deliberately.
- **Use a process supervisor in dev.** PGlite + Vite is the whole runtime.
  Adding pm2/systemd/etc. is for chapter 18.
- **Ship a test suite.** Each non-trivial module exports a
  `run<Subsystem>SelfTest()` function that exercises the happy path. A
  full vitest harness is a deliberate future addition once the codebase
  is stable enough to write meaningful integration tests against.

If you're starting a real PDS deployment from this codebase, that list is
your TODO.
