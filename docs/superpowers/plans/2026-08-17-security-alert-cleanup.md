# Security Alert Cleanup Implementation Plan

> **For Codex:** Execute this plan task by task with regression tests first and fresh verification before completion.

**Goal:** Remove the actionable dependency, filesystem, and regular-expression security findings while recording reviewable evidence for PayOps' database-backed API rate limiting.

**Architecture:** Preserve the existing security model. Pilot inputs will be opened once and inspected through the same file descriptor, while audit outputs will keep atomic temporary-file replacement without a check-then-use target lookup. The transitive Lodash version will be constrained centrally through pnpm. The API will retain its durable `RateLimitStore`; documentation and tests will make that custom control explicit instead of replacing it with process-local middleware solely to satisfy a scanner model.

**Tech Stack:** TypeScript, Node.js file handles, pnpm overrides, Vitest, Fastify, PostgreSQL-backed rate limiting, GitHub CodeQL.

---

## Task 1: Protect pilot file reads from path replacement

**Files:**

- Modify: `packages/pilot/test/manifest.test.ts`
- Modify: `packages/pilot/src/manifest/parse-manifest.ts`

1. Add a regression test proving that a final-component CSV symlink is rejected even when it points to a file inside the allowed manifest directory.
2. Run the manifest test and confirm the new test fails against the current realpath-then-stat/read behavior.
3. Resolve and validate the parent directory, open the final path with `O_NOFOLLOW`, and perform both regular-file validation and reading through that one file handle.
4. Run the manifest test and pilot typecheck.

## Task 2: Preserve atomic artifact writes without a target race

**Files:**

- Modify: `packages/pilot/test/report.test.ts`
- Modify: `packages/pilot/src/report/write-artifacts.ts`

1. Change the symlink regression to require safe atomic replacement of the output link while proving the link destination remains unchanged.
2. Run the report test and confirm the current implementation fails the new behavior.
3. Remove the check-then-rename lookup of the destination. Keep the exclusive random temporary file, fsync, restrictive mode, atomic rename, and directory fsync.
4. Run the report test, full pilot tests, and pilot typecheck.

## Task 3: Close dependency and regex findings

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/platform/test/invoice-arithmetic.test.ts`

1. Correct the alternation so both accepted error-code prefixes are anchored.
2. Add a pnpm override for Lodash `4.18.1`, the current non-deprecated release above every affected range, and regenerate installed dependencies and the lockfile.
3. Verify the resolved Lodash version and run `pnpm audit --prod`.
4. Run the platform test and repository typecheck.

## Task 4: Make custom rate-limit coverage auditable

**Files:**

- Add: `apps/api/test/bootstrap-acceptance.test.ts`
- Add: `apps/api/src/routes/bootstrap-acceptance.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `packages/platform/src/rate-limit/public-analysis-rate-limit-store.ts`
- Add: `docs/security/rate-limit-control-evidence.md`
- Add: `scripts/test/rate-limit-control-evidence.test.mjs`

1. Add a failing route test proving bootstrap acceptance is rejected before password hashing when its durable public limiter denies the request.
2. Namespace the durable public rate-limit buckets and add bootstrap acceptance to the same database-backed mechanism with a distinct namespace.
3. Add a failing repository test that requires every protected API route module to retain its rate-limit consumption points and requires a versioned evidence document.
4. Add concise evidence describing the shared database-backed controls, route groups, failure behavior, and why the CodeQL npm-middleware model does not recognize them.
5. Run the evidence test and API tests that exercise rate-limit rejection.

## Task 5: Verify and commit

1. Run formatting, type checking, unit tests, production audit, and the repository release verification command.
2. Inspect the final diff for scope and secrets.
3. Commit the verified changes on `codex/security-cleanup` without pushing or merging.
