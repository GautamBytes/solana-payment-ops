# Contributing to PayOps

PayOps accepts focused fixes, tests, documentation, and protocol integrations.
Payment correctness and reproducible evidence take priority over convenience.
Participation in project spaces is governed by
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before opening a pull request

Search existing issues and the public roadmap first. Use the appropriate
[issue form](.github/ISSUE_TEMPLATE) for a reproducible bug, focused feature
request, or usage question. For suspected vulnerabilities, follow
[SECURITY.md](SECURITY.md) and report privately instead of opening an issue.

Small fixes with an obvious scope can go directly to a pull request. For larger
changes, open an issue first so the problem, contract impact, and boundaries can
be agreed before implementation.

## Prerequisites

- Node.js 22.18.0 or newer
- pnpm 11.15.0
- Docker-compatible PostgreSQL 16 for database-backed tests

Install without running dependency lifecycle scripts:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Start the disposable repository database when a change touches ingestion,
reconciliation, webhooks, command-line tools, API, worker, or platform behavior:

```bash
docker compose -f packages/ingestion/docker-compose.test.yml up -d --wait
export DATABASE_URL=postgres://payops:payops@127.0.0.1:55432/payops_test
```

Never point tests at a production or shared database.

## Development loop

Use red-green-refactor for behavior changes: add a focused failing regression,
make the smallest correct change, then simplify while the test remains green.
Run the narrow package tests during development and the repository gate before
requesting review:

```bash
pnpm check
pnpm schemas:check
pnpm openapi:check
pnpm conformance fixtures/v0.1/manifest.json
pnpm packages:verify
pnpm audit --prod
```

If a JSON Schema, fixture, OpenAPI document, or generated SDK changes, update
its source and regenerate it with the repository script; do not hand-edit
generated output. Existing numbered database migrations are immutable. Add a
new idempotent migration and test both a clean install and an upgrade.

## Security and pull-request scope

Do not commit secrets, private keys, `.env` files, customer payment data,
credential-bearing URLs, private merchant reports, release evidence, tarballs,
or local planning notes. Preserve the non-custodial boundary, exact-integer
amounts, finalized-chain requirement, fail-closed parsing, idempotency, secret
redaction, SSRF controls, and append-only evidence.

Keep each pull request to one coherent outcome. Describe user impact, security
and migration implications, and the commands actually run. Do not publish npm
packages, create release tags, or mutate external production systems from a
feature branch. Report suspected vulnerabilities through [SECURITY.md](SECURITY.md),
not a public issue.
