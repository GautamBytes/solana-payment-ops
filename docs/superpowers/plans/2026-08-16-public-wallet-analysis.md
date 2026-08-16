# Public Wallet Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, no-account `Use a public wallet` mode that reads bounded public Solana USDC/USDT activity, reports verifiable transfer facts, and distinguishes those facts from invoice matching.

**Architecture:** Build a bounded stateless analysis service in `@payops/ingestion`, a PostgreSQL-backed public rate limiter in `@payops/platform`, and an unauthenticated but trusted-origin Fastify route in `@payops/api`. Enable the corresponding `/try` UI mode only through an explicit deployment flag after the API is healthy; keep all results in browser state and leave authenticated organization data untouched.

**Tech Stack:** TypeScript 7, Fastify 5, PostgreSQL 16, existing `HttpSolanaRpc`, `@payops/core` parser contracts through ingestion, Next.js 16, React 19, Vitest 4, Playwright 1.62, OpenAPI 3.1.

## Global Constraints

- Implement this plan only after `2026-08-16-try-payops-sample-workspace.md` passes its acceptance gate.
- Node.js must remain `>=22.18.0`; pnpm must remain `11.15.0`.
- Accept only Solana public addresses; never request or accept wallet connections, signatures, seed phrases, or private keys.
- Analyze canonical mainnet USDC and USDT only.
- Use 7-day and 30-day ranges only; inspect at most 200 signatures and fetch at most 100 finalized transactions per request.
- Use four concurrent transaction fetches at most, a 20-second total analysis deadline, the RPC client's existing one-megabyte response bound, and no redirect following.
- Persist rate-limit buckets only; do not persist wallet addresses, raw IP addresses, RPC envelopes, transfers, expectations, or results.
- Hash the direct client address with a deployment secret before rate-limit storage.
- Return bounded error codes and request IDs; never return raw provider errors.
- Do not claim `matched`, `reconciled`, or `invoice paid` unless asset, amount, recipient, and reference expectations are all present and all pass.
- Keep the sample workspace usable through every live-analysis failure.
- Do not change `/operations`, Better Auth signup policy, organization membership, wallet registration, invoice persistence, or production authority.

---

## File Structure

- Create `packages/ingestion/src/public-analysis/wallet-analysis.ts`: bounded address-history traversal, transaction parsing, safe transfer model, and optional expectation checks.
- Create `packages/ingestion/test/wallet-analysis.test.ts`: fake-RPC unit coverage.
- Modify `packages/ingestion/src/index.ts`: export the public analysis boundary.
- Create `packages/platform/migrations/4016_public_analysis_rate_limits.sql`: non-tenant rate-limit buckets containing digested client scopes only.
- Create `packages/platform/src/rate-limit/public-analysis-rate-limit-store.ts`: atomic client plus global limits.
- Create `packages/platform/test/public-analysis-rate-limit.test.ts`: migration contract and integration behavior.
- Modify `packages/platform/src/db/migrate.ts`, `packages/platform/src/db/production-role-bootstrap.ts`, `packages/platform/src/index.ts`, and migration expectation tests.
- Create `apps/api/src/routes/public-wallet-analysis.ts`: trusted-origin public endpoint, safe input parsing, address derivation, rate limiting, and response mapping.
- Create `apps/api/test/public-wallet-analysis.test.ts`: route-level contract tests.
- Modify `apps/api/src/config.ts`, `apps/api/src/server.ts`, and `apps/api/test/config.test.ts`: feature configuration and wiring.
- Modify `openapi/payops-v1.json` and regenerate `packages/sdk/src/generated/payops-v1.ts`.
- Create `apps/web/lib/public-wallet-analysis.ts`: client request/response parser and safe UI error type.
- Modify `apps/web/app/try/page.tsx`, `apps/web/components/try-workspace.tsx`, and `apps/web/styles/try.css`: feature-gated public-wallet mode.
- Create `apps/web/test/public-wallet-analysis.test.tsx`: client parsing and rendered-state coverage.
- Modify `apps/web/test/e2e/fixture-api.mjs` and create `apps/web/test/e2e/public-wallet-analysis.spec.ts`: browser scenarios.
- Modify `deploy/.env.example`, `deploy/compose.yaml`, `deploy/environment.md`, `deploy/README.md`, and `README.md`: explicit enablement and accurate hosted-operation language.

---

### Task 1: Bounded public-wallet analysis domain service

**Files:**

- Create: `packages/ingestion/src/public-analysis/wallet-analysis.ts`
- Create: `packages/ingestion/test/wallet-analysis.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**

- Consumes: `SolanaRpcPort`, `parseTransactionTransfers`, and API-derived canonical token-account addresses.
- Produces: `analyzePublicWallet(input, dependencies)`, `PublicWalletAnalysis`, `PublicWalletAnalysisInput`, `PublicWalletTransfer`, and `PublicWalletAnalysisError`.

- [ ] **Step 1: Write failing service tests with a fake RPC**

Create `packages/ingestion/test/wallet-analysis.test.ts` with a `FakeRpc` implementing `SolanaRpcPort`. Cover these exact cases:

```ts
import fixture from "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import type { AddressSignature, SolanaRpcPort } from "../src/domain/types";
import { analyzePublicWallet } from "../src/public-analysis/wallet-analysis";

const walletAddress = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";
const usdcTokenAccount = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const usdtTokenAccount = "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e";
const signature = fixture.rpcTransaction.signature;

describe("public wallet analysis", () => {
  it("returns finalized supported transfers without claiming invoice matching", async () => {
    const rpc = fakeRpc(
      [
        {
          signature,
          slot: 345678901n,
          blockTime: 1786000000n,
          err: null,
          confirmationStatus: "finalized",
        },
      ],
      fixture.rpcTransaction,
    );
    const result = await analyzePublicWallet(
      {
        walletAddress,
        watchedTokenAccounts: [
          { assetSymbol: "USDC", address: usdcTokenAccount },
          { assetSymbol: "USDT", address: usdtTokenAccount },
        ],
        fromTime: new Date("2026-08-01T00:00:00.000Z"),
        throughTime: new Date("2026-08-07T00:00:00.000Z"),
      },
      { rpc, maxSignatures: 200, maxTransactions: 100, concurrency: 4 },
    );
    expect(result.coverage).toBe("complete");
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      signature,
      assetSymbol: "USDC",
      amountBaseUnits: "12500000",
      expectationStatus: "not_provided",
    });
    expect(JSON.stringify(result)).not.toMatch(/invoice paid|reconciled/i);
  });

  it("marks complete four-field expectations as matched only when every check passes", async () => {
    const rpc = fakeRpc(
      [
        {
          signature,
          slot: 345678901n,
          blockTime: 1786000000n,
          err: null,
          confirmationStatus: "finalized",
        },
      ],
      fixture.rpcTransaction,
    );
    const result = await analyzePublicWallet(
      {
        walletAddress,
        watchedTokenAccounts: [
          { assetSymbol: "USDC", address: usdcTokenAccount },
        ],
        fromTime: new Date("2026-08-01T00:00:00.000Z"),
        throughTime: new Date("2026-08-07T00:00:00.000Z"),
        expectation: {
          assetSymbol: "USDC",
          amountBaseUnits: "12500000",
          destinationTokenAccount: usdcTokenAccount,
          reference: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
        },
      },
      { rpc, maxSignatures: 200, maxTransactions: 100, concurrency: 4 },
    );
    expect(result.transfers[0]?.expectationStatus).toBe("matched");
    expect(result.transfers[0]?.expectationChecks).toHaveLength(4);
    expect(
      result.transfers[0]?.expectationChecks.every(({ passed }) => passed),
    ).toBe(true);
  });

  it("reports partial coverage when the signature cap is reached before the date boundary", async () => {
    const entries = Array.from({ length: 3 }, (_, index): AddressSignature => ({
      signature: `${index + 1}`.repeat(64),
      slot: BigInt(345678901 - index),
      blockTime: 1786000000n,
      err: null,
      confirmationStatus: "finalized",
    }));
    const result = await analyzePublicWallet(
      {
        walletAddress,
        watchedTokenAccounts: [
          { assetSymbol: "USDC", address: usdcTokenAccount },
        ],
        fromTime: new Date("2026-08-01T00:00:00.000Z"),
        throughTime: new Date("2026-08-07T00:00:00.000Z"),
      },
      {
        rpc: fakeRpc(entries, fixture.rpcTransaction),
        maxSignatures: 2,
        maxTransactions: 2,
        concurrency: 1,
      },
    );
    expect(result.coverage).toBe("partial");
  });
});

function fakeRpc(
  entries: readonly AddressSignature[],
  transaction: unknown,
): SolanaRpcPort {
  return {
    getSignaturesForAddress: async ({ before, limit }) =>
      before === undefined ? entries.slice(0, limit) : [],
    getTransaction: async () =>
      transaction as Awaited<ReturnType<SolanaRpcPort["getTransaction"]>>,
    getSignatureStatuses: async () => [],
    getSlot: async () => 345678999n,
  };
}
```

- [ ] **Step 2: Run the tests and verify the red state**

```bash
pnpm --filter @payops/ingestion test -- test/wallet-analysis.test.ts
```

Expected: FAIL because `public-analysis/wallet-analysis.ts` does not exist.

- [ ] **Step 3: Define the safe public contracts**

In `wallet-analysis.ts`, define and export:

```ts
export type PublicAssetSymbol = "USDC" | "USDT";
export type ExpectationStatus =
  "not_provided" | "partial" | "matched" | "not_matched";

export interface PublicWalletExpectation {
  readonly assetSymbol?: PublicAssetSymbol;
  readonly amountBaseUnits?: string;
  readonly destinationTokenAccount?: string;
  readonly reference?: string;
}

export interface PublicWalletAnalysisInput {
  readonly walletAddress: string;
  readonly watchedTokenAccounts: readonly {
    readonly assetSymbol: PublicAssetSymbol;
    readonly address: string;
  }[];
  readonly fromTime: Date;
  readonly throughTime: Date;
  readonly expectation?: PublicWalletExpectation;
}

export interface PublicWalletTransfer {
  readonly signature: string;
  readonly slot: string;
  readonly blockTime: string;
  readonly assetSymbol: PublicAssetSymbol;
  readonly mint: string;
  readonly amountBaseUnits: string;
  readonly amountTokens: string;
  readonly sourceTokenAccount: string;
  readonly destinationTokenAccount: string;
  readonly references: readonly string[];
  readonly expectationStatus: ExpectationStatus;
  readonly expectationChecks: readonly {
    readonly field: "asset" | "amount" | "recipient" | "reference";
    readonly passed: boolean;
  }[];
}

export interface PublicWalletAnalysis {
  readonly schemaVersion: "0.1";
  readonly walletAddress: string;
  readonly fromTime: string;
  readonly throughTime: string;
  readonly coverage: "complete" | "partial";
  readonly transfers: readonly PublicWalletTransfer[];
}

export class PublicWalletAnalysisError extends Error {
  public constructor(
    public readonly code:
      "invalid_analysis_input" | "analysis_unavailable" | "analysis_too_large",
    options?: { readonly cause?: unknown },
  ) {
    super("Public wallet analysis failed", options);
    this.name = "PublicWalletAnalysisError";
  }
}
```

- [ ] **Step 4: Implement bounded traversal and parsing**

Implement `analyzePublicWallet` with these exact rules:

```ts
export async function analyzePublicWallet(
  input: PublicWalletAnalysisInput,
  dependencies: {
    readonly rpc: SolanaRpcPort;
    readonly maxSignatures: number;
    readonly maxTransactions: number;
    readonly concurrency: number;
  },
): Promise<PublicWalletAnalysis>;
```

Validation:

```ts
const rangeMs = input.throughTime.getTime() - input.fromTime.getTime();
if (
  !Number.isFinite(input.fromTime.getTime()) ||
  !Number.isFinite(input.throughTime.getTime()) ||
  rangeMs <= 0 ||
  rangeMs > 30 * 24 * 60 * 60 * 1_000 ||
  input.watchedTokenAccounts.length < 1 ||
  input.watchedTokenAccounts.length > 2 ||
  dependencies.maxSignatures < 1 ||
  dependencies.maxSignatures > 200 ||
  dependencies.maxTransactions < 1 ||
  dependencies.maxTransactions > 100 ||
  dependencies.concurrency < 1 ||
  dependencies.concurrency > 4
)
  throw new PublicWalletAnalysisError("invalid_analysis_input");
```

For each watched token account, call `getSignaturesForAddress` with `commitment:
"confirmed"`, pages of at most 100, and `before` cursors. Stop when the oldest
non-null block time is before `fromTime`, the provider returns an empty page, or
the shared signature cap is reached. Deduplicate by signature. Retain entries
whose block time is within `[fromTime, throughTime]`, whose error is null, and
whose confirmation status is `finalized`. Set coverage to `partial` when the cap
is reached before a date boundary or any retained candidate has null block time.

Fetch at most `maxTransactions` retained signatures at concurrency
`dependencies.concurrency` using `getTransaction(signature, "finalized")`.
Parse each non-null transaction with:

```ts
parseTransactionTransfers(transaction, {
  watchedAddress: tokenAccount.address,
});
```

Keep only transfers whose mint equals `MAINNET_USDC.mint` or
`MAINNET_USDT.mint` and whose source or destination token account equals the
watched token account. Format six-decimal token amounts with integer arithmetic,
never `Number`.

Expectation logic must generate one check for every provided field. Return
`not_provided` for zero fields, `partial` for one to three fields,
`not_matched` when four fields exist and any check fails, and `matched` only
when all four fields exist and pass.

Wrap `IngestionError`, parser failures, and aborts as
`PublicWalletAnalysisError("analysis_unavailable", { cause })`; never copy the
provider message into the result.

- [ ] **Step 5: Export and verify the domain boundary**

Add to `packages/ingestion/src/index.ts`:

```ts
export {
  analyzePublicWallet,
  PublicWalletAnalysisError,
  type ExpectationStatus,
  type PublicAssetSymbol,
  type PublicWalletAnalysis,
  type PublicWalletAnalysisInput,
  type PublicWalletExpectation,
  type PublicWalletTransfer,
} from "./public-analysis/wallet-analysis.js";
```

Run:

```bash
pnpm --filter @payops/ingestion test -- test/wallet-analysis.test.ts
pnpm --filter @payops/ingestion typecheck
pnpm --filter @payops/ingestion build
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the analysis service**

```bash
git add packages/ingestion/src/public-analysis/wallet-analysis.ts packages/ingestion/src/index.ts packages/ingestion/test/wallet-analysis.test.ts
git commit -m "feat(ingestion): add bounded public wallet analysis"
```

---

### Task 2: Persistent public rate limits without wallet or IP storage

**Files:**

- Create: `packages/platform/migrations/4016_public_analysis_rate_limits.sql`
- Create: `packages/platform/src/rate-limit/public-analysis-rate-limit-store.ts`
- Create: `packages/platform/test/public-analysis-rate-limit.test.ts`
- Modify: `packages/platform/src/db/migrate.ts`
- Modify: `packages/platform/src/db/production-role-bootstrap.ts`
- Modify: `packages/platform/src/index.ts`
- Modify: `packages/platform/test/hosted-migrations.integration.test.ts`
- Modify: `packages/platform/test/migrations.integration.test.ts`

**Interfaces:**

- Produces: `PublicAnalysisRateLimitStore.consume({ clientDigest, now })` and
  `PublicAnalysisRateLimitStore.close()`.
- Consumers: public API route in Task 3.

- [ ] **Step 1: Write migration and store tests first**

Create `packages/platform/test/public-analysis-rate-limit.test.ts` with:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PLATFORM_MIGRATION_NAMES } from "../src/index.js";

describe("public analysis rate-limit boundary", () => {
  it("registers a non-tenant bucket containing digested scopes only", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/4016_public_analysis_rate_limits.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(PLATFORM_MIGRATION_NAMES.at(-1)).toBe(
      "4016_public_analysis_rate_limits",
    );
    expect(sql).toContain("CREATE TABLE public_analysis_rate_limit_buckets");
    expect(sql).toContain("scope_digest text");
    expect(sql).toContain("scope_digest ~ '^[0-9a-f]{64}$'");
    expect(sql).not.toMatch(/wallet|ip_address|remote_address/);
  });
});
```

Extend the existing database-backed rate-limit integration suite with a case
that constructs two `PublicAnalysisRateLimitStore` instances using the same
scoped database URL, consumes client digest `"a".repeat(64)` three times with
`clientLimit: 2`, and expects remaining values `1`, `0`, then `allowed: false`.
Use a second digest to prove `globalLimit` blocks the combined fourth request.

- [ ] **Step 2: Run the tests and verify the red state**

```bash
pnpm --filter @payops/platform test:unit -- test/public-analysis-rate-limit.test.ts
```

Expected: FAIL because migration 4016 and its store do not exist.

- [ ] **Step 3: Add the additive migration**

Create `4016_public_analysis_rate_limits.sql`:

```sql
CREATE TABLE public_analysis_rate_limit_buckets (
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
  bucket_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_digest, bucket_started_at)
);

CREATE INDEX public_analysis_rate_limit_expiry
  ON public_analysis_rate_limit_buckets (bucket_started_at);
```

Append `"4016_public_analysis_rate_limits"` to `PLATFORM_MIGRATION_NAMES`.
Update exact migration-count expectations from 15 to 16 and append the name to
the hosted migration list.

- [ ] **Step 4: Implement atomic client and global consumption**

Create `public-analysis-rate-limit-store.ts` with constructor:

```ts
new PublicAnalysisRateLimitStore(databaseUrl, {
  clientLimit: 5,
  globalLimit: 100,
  windowSeconds: 60,
});
```

`consume({ clientDigest, now })` validates a lowercase 64-character SHA-256
digest, computes the fixed window, and increments both
`sha256("client:" + clientDigest)` and `sha256("global")` inside one PostgreSQL
transaction using this statement for each scope:

```sql
INSERT INTO public_analysis_rate_limit_buckets (
  scope_digest, bucket_started_at, request_count, updated_at
) VALUES ($scope, $bucket, 1, $now)
ON CONFLICT (scope_digest, bucket_started_at)
DO UPDATE SET request_count = public_analysis_rate_limit_buckets.request_count + 1,
              updated_at = EXCLUDED.updated_at
RETURNING request_count;
```

Return:

```ts
export interface PublicAnalysisRateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}
```

`allowed` is true only when both client and global counts are within their
limits. `remaining` reports the client remainder. Export the class and types
from `packages/platform/src/index.ts`. Add `close(): Promise<void>` to close the
store's PostgreSQL pool; make it idempotent so the API shutdown hook can call it
exactly like the repository's other database-backed stores.

- [ ] **Step 5: Grant the production runtime only required table privileges**

In `production-role-bootstrap.ts`, include the new table in ownership setup and
grant the runtime principal `SELECT, INSERT, UPDATE`. Do not grant `DELETE`,
`TRUNCATE`, or access to any organization table as part of this change.

- [ ] **Step 6: Run migration and integration verification**

```bash
pnpm --filter @payops/platform test
pnpm --filter @payops/platform typecheck
pnpm --filter @payops/platform build
```

Expected: all commands exit 0; database tests run when `DATABASE_URL` is set and
otherwise report their existing skipped state.

- [ ] **Step 7: Commit the rate-limit boundary**

```bash
git add packages/platform/migrations/4016_public_analysis_rate_limits.sql packages/platform/src/rate-limit/public-analysis-rate-limit-store.ts packages/platform/src/db/migrate.ts packages/platform/src/db/production-role-bootstrap.ts packages/platform/src/index.ts packages/platform/test/public-analysis-rate-limit.test.ts packages/platform/test/hosted-migrations.integration.test.ts packages/platform/test/migrations.integration.test.ts
git commit -m "feat(platform): persist public analysis rate limits"
```

---

### Task 3: Feature configuration and public API route

**Files:**

- Create: `apps/api/src/routes/public-wallet-analysis.ts`
- Create: `apps/api/test/public-wallet-analysis.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/config.test.ts`

**Interfaces:**

- Consumes: `analyzePublicWallet`, `PublicAnalysisRateLimitStore`, `associatedTokenAddress`, and `assetBySymbol`.
- Produces: `POST /v1/public/wallet-analysis` and `OPTIONS /v1/public/wallet-analysis`.

- [ ] **Step 1: Write failing route tests**

Create `apps/api/test/public-wallet-analysis.test.ts` around
`registerPublicWalletAnalysisRoutes` using dependency fakes. Cover:

```ts
it("requires a trusted origin but no session", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/v1/public/wallet-analysis",
    headers: {
      origin: "https://pay.example",
      "content-type": "application/json",
    },
    payload: { walletAddress, rangeDays: 7 },
  });
  expect(response.statusCode).toBe(200);
  expect(analyze).toHaveBeenCalledOnce();
});

it("rejects invalid input before consuming RPC", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/v1/public/wallet-analysis",
    headers: {
      origin: "https://pay.example",
      "content-type": "application/json",
    },
    payload: { walletAddress: "not-an-address", rangeDays: 7 },
  });
  expect(response.statusCode).toBe(400);
  expect(analyze).not.toHaveBeenCalled();
});

it("returns retry-after for a rejected rate-limit claim", async () => {
  rateLimits.consume.mockResolvedValue({
    allowed: false,
    limit: 5,
    remaining: 0,
    retryAfterSeconds: 42,
  });
  const response = await server.inject(validRequest);
  expect(response.statusCode).toBe(429);
  expect(response.headers["retry-after"]).toBe("42");
  expect(response.json()).toMatchObject({
    code: "public_analysis_rate_limited",
  });
});
```

Also assert that `analysis_unavailable` maps to 503, `coverage: "partial"`
survives unchanged, every `ApiError` body includes the request's `requestId`,
and no response contains the fake provider error message.

- [ ] **Step 2: Run the test and verify the red state**

```bash
pnpm --filter @payops/api test:unit -- test/public-wallet-analysis.test.ts
```

Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Add explicit opt-in configuration**

Extend `ApiConfig` with:

```ts
readonly publicAnalysis?: {
  readonly clientDigestSecret: string;
  readonly clientLimit: number;
  readonly globalLimit: number;
  readonly windowSeconds: number;
};
```

Parse `PAYOPS_PUBLIC_ANALYSIS_ENABLED` as exactly `"true"` or `"false"`,
defaulting to `"false"`. When true, require
`PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET` to be canonical base64url encoding
of at least 32 bytes. Parse these bounded integers:

```text
PAYOPS_PUBLIC_ANALYSIS_CLIENT_LIMIT: default 5, range 1..100
PAYOPS_PUBLIC_ANALYSIS_GLOBAL_LIMIT: default 100, range 1..10000
PAYOPS_PUBLIC_ANALYSIS_WINDOW_SECONDS: default 60, range 1..3600
```

Add config tests for disabled, enabled-valid, missing secret, malformed secret,
and bounds. Do not make existing deployments provide new variables while the
feature is disabled.

- [ ] **Step 4: Implement strict body parsing and origin handling**

`public-wallet-analysis.ts` must accept the exact body:

```ts
interface PublicWalletAnalysisRequest {
  readonly walletAddress: string;
  readonly rangeDays: 7 | 30;
  readonly expectation?: {
    readonly assetSymbol?: "USDC" | "USDT";
    readonly amountTokens?: string;
    readonly recipient?: string;
    readonly reference?: string;
  };
}
```

Reject extra keys. Validate addresses with `canonicalSolanaAddress`. Validate
`amountTokens` using `/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/`, then convert it
to six-decimal base units with string padding. Derive USDC and USDT associated
token accounts for `walletAddress`. If `recipient` is present, derive the
destination token account for the supplied `assetSymbol`; reject a recipient
without an asset.

Require `Origin` to equal one configured trusted origin. Set
`access-control-allow-origin` to that exact origin, `vary: Origin`, and
`cache-control: no-store`. Implement an OPTIONS response allowing only POST and
`content-type`.

- [ ] **Step 5: Hash the client scope and execute the bounded analysis**

Derive the stored client digest without retaining the raw address:

```ts
const clientDigest = createHmac("sha256", dependencies.clientDigestSecret)
  .update(request.ip)
  .digest("hex");
```

Consume the rate limit before RPC access. Call the analysis service with:

```ts
{
  walletAddress,
  watchedTokenAccounts,
  fromTime: new Date(now.getTime() - rangeDays * 86_400_000),
  throughTime: now,
  ...(expectation === undefined ? {} : { expectation }),
}
```

and fixed dependencies:

```ts
{ maxSignatures: 200, maxTransactions: 100, concurrency: 4 }
```

Use `AbortSignal.timeout(20_000)` when constructing the request-scoped RPC
client. Map errors to these responses only:

```text
400 invalid_public_analysis_request
403 untrusted_origin
429 public_analysis_rate_limited
503 public_analysis_unavailable
```

Construct each response through the existing `ApiError`/error-handler boundary
so `requestId` remains present. Validation failures may identify only these
bounded fields: `walletAddress`, `rangeDays`, `assetSymbol`, `amountTokens`,
`recipient`, or `reference`; never echo a provider message or arbitrary input.

- [ ] **Step 6: Wire the route only when enabled**

In `server.ts`, when `config.publicAnalysis` exists:

- construct `PublicAnalysisRateLimitStore` with its limits;
- construct a request-scoped `HttpSolanaRpc` using the primary configured RPC
  endpoint and a 20-second signal;
- register the route;
- close the rate-limit store in `onClose`.

When disabled, do not register the route. Existing API routes and readiness
behavior remain unchanged.

- [ ] **Step 7: Run API verification**

```bash
pnpm --filter @payops/api test:unit -- test/public-wallet-analysis.test.ts test/config.test.ts
pnpm --filter @payops/api typecheck
pnpm --filter @payops/api build
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the endpoint**

```bash
git add apps/api/src/config.ts apps/api/src/routes/public-wallet-analysis.ts apps/api/src/server.ts apps/api/test/config.test.ts apps/api/test/public-wallet-analysis.test.ts
git commit -m "feat(api): expose bounded public wallet analysis"
```

---

### Task 4: OpenAPI and generated SDK contract

**Files:**

- Modify: `openapi/payops-v1.json`
- Modify: `packages/sdk/src/generated/payops-v1.ts`
- Modify: `apps/api/test/openapi-contract.test.ts`

**Interfaces:**

- Consumes: route request and response from Task 3.
- Produces: operation `analyzePublicWallet` with no authentication requirement.

- [ ] **Step 1: Add a failing OpenAPI assertion**

In `apps/api/test/openapi-contract.test.ts`, assert:

```ts
expect(document.paths["/v1/public/wallet-analysis"]?.post).toMatchObject({
  operationId: "analyzePublicWallet",
  security: [],
});
```

- [ ] **Step 2: Run the contract test and verify the red state**

```bash
pnpm --filter @payops/api test:unit -- test/openapi-contract.test.ts
```

Expected: FAIL because the path is absent.

- [ ] **Step 3: Define the complete OpenAPI path and schemas**

Add `POST /v1/public/wallet-analysis` with `security: []`, required Origin
behavior in the description, the exact request from Task 3, and responses 200,
400, 403, 429, and 503. Define closed schemas for:

```text
PublicWalletAnalysisRequest
PublicWalletExpectation
PublicWalletAnalysis
PublicWalletTransfer
PublicExpectationCheck
```

Use enums from the service contracts, `additionalProperties: false`, max 100
transfers, max 16 references per transfer, decimal strings rather than JSON
numbers, and the existing `ApiError` response.

- [ ] **Step 4: Regenerate and verify**

```bash
pnpm sdk:generate
pnpm openapi:check
pnpm --filter @payops/api test:unit -- test/openapi-contract.test.ts
pnpm --filter @payops/sdk test
```

Expected: all commands exit 0 and generator check produces no diff on a second
run.

- [ ] **Step 5: Commit the contract**

```bash
git add openapi/payops-v1.json packages/sdk/src/generated/payops-v1.ts apps/api/test/openapi-contract.test.ts
git commit -m "feat(api): publish public wallet analysis contract"
```

---

### Task 5: Feature-gated public-wallet mode in `/try`

**Files:**

- Create: `apps/web/lib/public-wallet-analysis.ts`
- Create: `apps/web/test/public-wallet-analysis.test.tsx`
- Modify: `apps/web/app/try/page.tsx`
- Modify: `apps/web/components/try-workspace.tsx`
- Modify: `apps/web/styles/try.css`

**Interfaces:**

- Consumes: `POST /v1/public/wallet-analysis` from Tasks 3–4.
- Produces: `analyzeWallet(input): Promise<PublicWalletAnalysis>` and a mode selector shown only when enabled.

- [ ] **Step 1: Write failing client and UI tests**

Create `apps/web/test/public-wallet-analysis.test.tsx` and cover:

```ts
it("does not render a dead public-wallet action when disabled", () => {
  const markup = renderToStaticMarkup(
    createElement(TryWorkspaceView, {
      workspace: sampleWorkspace,
      publicWalletEnabled: false,
    }),
  );
  expect(markup).not.toContain("Use a public wallet");
});

it("renders the safe public-wallet form when enabled", () => {
  const markup = renderToStaticMarkup(
    createElement(TryWorkspaceView, {
      workspace: sampleWorkspace,
      publicWalletEnabled: true,
    }),
  );
  expect(markup).toContain("Use a public wallet");
  expect(markup).toContain("Never enter a seed phrase or private key");
  expect(markup).toContain('name="walletAddress"');
  expect(markup).toContain('name="rangeDays"');
  expect(markup).not.toMatch(/connect wallet/i);
});
```

Add parser tests using a valid complete response, an oversized transfer array,
an unknown expectation status, a 429 response with `retry-after: 42`, and a 503
response containing an attacker-controlled provider message. Expect only safe
`PublicWalletClientError` codes to reach the component. Add interaction tests
that submit an invalid address and an invalid expectation amount, assert each
message is tied to and focuses the corresponding field without clearing the
form, and assert the canonical-USDC/USDT support note plus polite live-status
region are present.

- [ ] **Step 2: Run tests and verify the red state**

```bash
pnpm --filter @payops/web test -- test/public-wallet-analysis.test.tsx
```

Expected: FAIL because the client module and component prop do not exist.

- [ ] **Step 3: Implement the bounded browser client**

Create `apps/web/lib/public-wallet-analysis.ts` with public input and response
types matching OpenAPI. Implement:

```ts
export async function analyzeWallet(
  input: PublicWalletAnalysisRequest,
): Promise<PublicWalletAnalysis> {
  const origin = exactApiOrigin(process.env.NEXT_PUBLIC_PAYOPS_API_ORIGIN);
  const response = await fetch(`${origin}/v1/public/wallet-analysis`, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw PublicWalletClientError.fromResponse(response);
  return parsePublicWalletAnalysis(await response.json());
}
```

`parsePublicWalletAnalysis` must enforce schema version `0.1`, 7/30-day input
echo, `complete|partial` coverage, at most 100 transfers, exact asset/status
enums, bounded strings, decimal integer amounts, valid timestamps, and at most
16 references. `PublicWalletClientError` retains an optional validated UUID
`requestId`, optional bounded validation field, and exposes only:

```text
invalid_request
rate_limited (with retryAfterSeconds)
unavailable
invalid_response
```

- [ ] **Step 4: Pass server-controlled enablement into the client component**

In `apps/web/app/try/page.tsx`:

```tsx
const publicWalletEnabled =
  process.env.PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED === "true";

export default function TryPage() {
  return (
    <TryWorkspaceView
      workspace={sampleWorkspace}
      publicWalletEnabled={publicWalletEnabled}
    />
  );
}
```

Do not default the feature to enabled.

- [ ] **Step 5: Add the two-mode interaction**

Extend `TryWorkspaceView` props with
`readonly publicWalletEnabled: boolean`. When enabled, render two tab-style
buttons with `role="tablist"`, `role="tab"`, `aria-selected`, and associated
`role="tabpanel"` elements:

```text
Explore sample workspace
Use a public wallet
```

The wallet panel contains wallet address, 7/30-day select, and an optional
fieldset with asset, amount, recipient, and reference. Submission uses
`analyzeWallet`, sets `aria-busy`, then moves focus to the result heading or
the first invalid field/error alert. Validate the same closed body and amount
grammar client-side before fetch, render field-specific messages without
clearing any entered value, and place loading/completion text in a
`role="status" aria-live="polite"` region.

Beside the asset control, keep this support boundary visible in both form and
results: `Currently supports canonical USDC and USDT transfers only.` This is
also the unsupported-token explanation; the select itself must not offer any
other asset.

Render these exact safe states:

```text
invalid_request: Check the public address and payment expectations.
rate_limited: Too many analyses. Try again in {seconds} seconds.
unavailable: Live analysis is temporarily unavailable. The sample workspace still works.
invalid_response: Live analysis returned an unreadable response. Try again later. Reference: {requestId when available}.
complete empty: No finalized canonical USDC or USDT transfers were found in this range.
partial: Coverage is incomplete. Do not treat missing activity as zero activity.
```

For every transfer, render observed facts, expectation checks, and one of:

```text
not_provided: Public transfer verified; no invoice expectations supplied.
partial: Public transfer verified; add all four expectations to test a match.
matched: All supplied payment expectations match this finalized transfer.
not_matched: The finalized transfer does not match every supplied expectation.
```

- [ ] **Step 6: Add responsive and accessible styles**

Under `.try-shell`, add selectors for `.try-modes`, `.try-wallet-form`,
`.try-wallet-disclosure`, `.try-wallet-results`, `.try-wallet-card`,
`.try-coverage-warning`, and `.try-error`. Use a two-column field grid above
760px and one column below. Use existing green, amber, and red operation colors
with text labels. Ensure focus styles cover `input`, `select`, and `button`.
Do not add horizontal tables.

- [ ] **Step 7: Run web verification**

```bash
pnpm --filter @payops/web test -- test/public-wallet-analysis.test.tsx test/try-workspace.test.tsx
pnpm --filter @payops/web typecheck
pnpm exec prettier --check apps/web/app/try/page.tsx apps/web/components/try-workspace.tsx apps/web/lib/public-wallet-analysis.ts apps/web/styles/try.css apps/web/test/public-wallet-analysis.test.tsx
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the public-wallet UI**

```bash
git add apps/web/app/try/page.tsx apps/web/components/try-workspace.tsx apps/web/lib/public-wallet-analysis.ts apps/web/styles/try.css apps/web/test/public-wallet-analysis.test.tsx
git commit -m "feat(web): add public wallet analysis mode"
```

---

### Task 6: Browser scenarios, deployment contract, and rollout language

**Files:**

- Modify: `apps/web/test/e2e/fixture-api.mjs`
- Create: `apps/web/test/e2e/public-wallet-analysis.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `deploy/.env.example`
- Modify: `deploy/compose.yaml`
- Modify: `deploy/environment.md`
- Modify: `deploy/README.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: complete API and web feature.
- Produces: deployable opt-in configuration and browser-level acceptance coverage.

- [ ] **Step 1: Add deterministic fixture API scenarios**

Extend `fixture-api.mjs` with `POST /v1/public/wallet-analysis` responses keyed
by `state.scenario`:

```text
wallet-success: one USDC transfer with expectationStatus matched
wallet-empty: complete coverage with []
wallet-partial: partial coverage with []
wallet-rate-limit: 429, retry-after 42, safe error body
wallet-unavailable: 503, safe error body
```

Reject any fixture request containing `seedPhrase`, `privateKey`, or
`signature` body keys with status 400. Add CORS for the configured web origin.

- [ ] **Step 2: Enable the feature in the Playwright web server only**

Add to the web server env in `playwright.config.ts`:

```ts
PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED: "true",
```

- [ ] **Step 3: Write browser acceptance tests**

Create `apps/web/test/e2e/public-wallet-analysis.spec.ts` covering:

```ts
test("analyzes a public wallet without account or connection", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "wallet-success" },
  });
  await page.goto("/try");
  await page.getByRole("tab", { name: "Use a public wallet" }).click();
  await page.getByLabel("Solana public address").fill(walletAddress);
  await page.getByRole("button", { name: "Analyze public activity" }).click();
  await expect(
    page.getByRole("heading", { name: "Public wallet results" }),
  ).toBeFocused();
  await expect(
    page.getByText("All supplied payment expectations match"),
  ).toBeVisible();
  await expect(page.getByText(/seed phrase or private key/i)).toBeVisible();
});
```

Add separate tests for empty, partial, rate-limited, and unavailable scenarios;
each must preserve a working `Explore sample workspace` tab. Add desktop axe and
mobile overflow assertions.

- [ ] **Step 4: Add explicit deployment inventory**

Add to `deploy/.env.example`:

```dotenv
PAYOPS_PUBLIC_ANALYSIS_ENABLED=false
PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET=<required-base64url-secret-when-enabled>
PAYOPS_PUBLIC_ANALYSIS_CLIENT_LIMIT=5
PAYOPS_PUBLIC_ANALYSIS_GLOBAL_LIMIT=100
PAYOPS_PUBLIC_ANALYSIS_WINDOW_SECONDS=60
PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED=false
```

Pass these variables to API and web services in `deploy/compose.yaml`. API gets
the first five; web gets only `PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED` and the
existing public API origin. Do not expose the digest secret to web.

Document in `deploy/environment.md` that operators enable the web flag only
after migration 4016, API readiness, trusted-origin CORS, and a successful
bounded mainnet smoke. Replace `pilot traffic` in `deploy/README.md` with `live
merchant traffic`; keep every readiness and backup requirement.

Update `README.md` so the sample workspace is self-serve, public-wallet analysis
is optional and read-only when enabled, and the hosted production stack still
has no SLA claim. Keep the `@payops/pilot` package documentation unchanged.

- [ ] **Step 5: Run the focused browser suite**

```bash
pnpm exec playwright test apps/web/test/e2e/try.spec.ts apps/web/test/e2e/public-wallet-analysis.spec.ts --project=desktop --project=mobile
```

Expected: all scenarios pass, axe reports zero serious or critical violations,
and mobile assertions report no horizontal overflow.

- [ ] **Step 6: Run full repository verification**

```bash
pnpm schemas:check
pnpm openapi:check
pnpm --filter @payops/ingestion test
pnpm --filter @payops/platform test
pnpm --filter @payops/api test
pnpm --filter @payops/web test
pnpm typecheck
pnpm format:check
pnpm check
```

Expected: every command exits 0 with no failing test.

- [ ] **Step 7: Run deployment-contract tests**

```bash
node --test scripts/test/deployment-contract.test.mjs
```

Expected: exit 0 and environment inventory assertions include the new variables
without exposing the digest secret to web.

- [ ] **Step 8: Commit rollout coverage and docs**

```bash
git add apps/web/test/e2e/fixture-api.mjs apps/web/test/e2e/public-wallet-analysis.spec.ts playwright.config.ts deploy/.env.example deploy/compose.yaml deploy/environment.md deploy/README.md README.md
git commit -m "test: verify public wallet analysis rollout"
```

---

## Plan Acceptance Gate

From a clean checkout with PostgreSQL available, verify:

```bash
pnpm check
pnpm schemas:check
pnpm openapi:check
pnpm exec playwright test apps/web/test/e2e/try.spec.ts apps/web/test/e2e/public-wallet-analysis.spec.ts --project=desktop --project=mobile
node --test scripts/test/deployment-contract.test.mjs
git status --short
```

Then perform one production-like smoke with the feature disabled and one with it
enabled:

```text
Disabled: /try shows no Use a public wallet control; sample mode works.
Enabled + healthy API: the control appears and a bounded known wallet returns a safe result.
Enabled + unavailable RPC: the UI shows temporary unavailability and sample mode still works.
```

Expected: all commands exit 0, all smoke assertions hold, no raw wallet or IP is
present in `public_analysis_rate_limit_buckets`, and `git status --short` is
empty.
