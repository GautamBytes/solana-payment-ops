# Embedded Public Wallet Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public-wallet form return bounded live Solana results from the Vercel-hosted web app without deploying the full PayOps API.

**Architecture:** Add a feature-gated same-origin Next.js route that adapts the existing ingestion analyzer to the Fetch API. Keep request preparation in the ingestion package so the Fastify API and embedded route share canonical validation and associated-token-account derivation. Use Vercel WAF for deployment-level per-IP rate limiting.

**Tech Stack:** TypeScript 7, Next.js 16 route handlers, Vitest, `@payops/ingestion`, `@solana/kit`, Vercel Functions and WAF.

## Global Constraints

- No paid service, database, account, wallet connection, or private credential from a visitor.
- Never persist or log wallet addresses or analysis results.
- Only mainnet USDC and USDT, 7-day and 30-day ranges, 40 signatures, 20 transactions, concurrency 2, and a 20-second upstream timeout.
- Production full-API behavior and contracts remain backward compatible.

---

### Task 1: Shared request preparation

**Files:**

- Create: `packages/ingestion/src/public-analysis/request.ts`
- Create: `packages/ingestion/test/public-wallet-request.test.ts`
- Modify: `packages/ingestion/src/index.ts`
- Modify: `apps/api/src/routes/public-wallet-analysis.ts`

**Interfaces:**

- Produces `preparePublicWalletAnalysisRequest(value, now)` with a typed request and analyzer input.
- The existing Fastify route consumes the shared result without changing its HTTP contract.

- [ ] Write tests for valid requests, exact keys, canonical addresses, expectation conversion, and invalid fields.
- [ ] Run the focused ingestion tests and confirm they fail because the shared parser is missing.
- [ ] Implement the parser and associated-token-account derivation.
- [ ] Refactor the Fastify route to consume it.
- [ ] Run ingestion and API public-analysis tests and confirm they pass.

### Task 2: Embedded handler

**Files:**

- Create: `apps/web/lib/server/embedded-public-wallet-analysis.ts`
- Create: `apps/web/app/v1/public-wallet-analysis/route.ts`
- Create: `apps/web/test/embedded-public-wallet-analysis.test.ts`
- Modify: `apps/web/package.json`

**Interfaces:**

- Produces `createEmbeddedPublicWalletAnalysisHandler(dependencies)` for isolated tests.
- The route exports `POST`, `runtime = "nodejs"`, and `maxDuration = 30`.

- [ ] Write handler tests for disabled mode, same-origin enforcement, body bounds, safe validation errors, safe upstream errors, and bounded analyzer options.
- [ ] Run the focused web test and confirm it fails because the handler is missing.
- [ ] Implement the handler factory and production dependencies.
- [ ] Run the focused test and confirm it passes.

### Task 3: Embedded client and readiness

**Files:**

- Modify: `apps/web/lib/public-wallet-analysis.ts`
- Modify: `apps/web/app/try/page.tsx`
- Modify: `apps/web/lib/runtime-config.ts`
- Modify: `apps/web/app/health/ready/route.ts`
- Modify: `apps/web/test/public-wallet-analysis.test.tsx`
- Modify: `apps/web/test/health.test.ts`

**Interfaces:**

- `analyzeWallet` uses the configured full API origin or a same-origin relative path.
- `parseWebRuntimeConfig` returns either full API mode or embedded mode.

- [ ] Add tests for relative client requests and embedded readiness configuration.
- [ ] Run the focused web tests and confirm the new assertions fail.
- [ ] Implement relative requests and embedded readiness.
- [ ] Run the focused web tests and confirm they pass.

### Task 4: Deployment controls and merge gate

**Files:**

- Modify: `deploy/environment.md`
- Modify: `deploy/checklists/public-self-serve-rollout.md`
- Modify: `scripts/check-hosted-self-serve.mjs`
- Modify: `scripts/test/check-hosted-self-serve.test.mjs`

**Interfaces:**

- The hosted checker supports the embedded endpoint while retaining the full API checks.

- [ ] Add a failing checker test for embedded mode.
- [ ] Implement the bounded hosted POST check without printing request or response data.
- [ ] Run `pnpm check`, `pnpm test:e2e`, and security-focused tests.
- [ ] Configure branch Preview environment variables and a Vercel WAF rate-limit rule.
- [ ] Deploy Preview and run the hosted smoke.
- [ ] Push changes, wait for all required GitHub checks, review the final diff, and merge PR #22.
