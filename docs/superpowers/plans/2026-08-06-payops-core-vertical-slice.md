# PayOps Core Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a deterministic command-line vertical slice that loads a raw Solana RPC payment fixture, parses a legacy SPL Token TransferChecked instruction, verifies it against an expected USDC payment, and emits a stable conformance report.

**Architecture:** A small Apache-2.0 TypeScript package owns fixture validation, Solana compiled-message account resolution, token-instruction parsing, payment verification, and canonical report serialization. The first slice is deliberately filesystem-only and deterministic: no database, network, dashboard, or merchant API is introduced before the correctness core works.

**Tech Stack:** Node.js 22.18 or newer, pnpm 11.15.0, TypeScript 7.0.2, Vitest 4.1.10, Zod 4.4.3, @solana/kit 7.0.0, bs58 6.0.0, tsx 4.23.9, Prettier 3.9.6.

## Global Constraints

- Use TypeScript strict mode, exactOptionalPropertyTypes, and noUncheckedIndexedAccess.
- Use integer strings and bigint for token quantities; never use floating-point token arithmetic.
- Accept only mainnet-beta USDC and USDT constants from an exact mint and token-program allowlist.
- The first conformance fixture covers canonical mainnet USDC with six decimals and the legacy SPL Token Program.
- Treat the Solana Pay reference as a public 32-byte read-only account key, never as proof of payment.
- Event identity is cluster + signature + outer instruction index + optional inner instruction index.
- A transaction-level token balance delta is reconciled against the aggregate of parsed instruction events, never against one instruction in isolation.
- Confirmed is provisional; finalized is the only passing commitment for this first conformance fixture.
- The package performs no signing, custody, transaction submission, RPC calls, database writes, or network calls.
- Every implementation step follows red-green-refactor and ends in a focused commit.
- Do not weaken types with any, type assertions, or floating-point conversions.

---

## Plan boundary and sequence

The approved product specification contains multiple subsystems. This plan implements the first independently useful subsystem only.

Subsequent plans will cover:

1. Durable RPC subscriptions, newest-first pagination, watermarks, retries, and finality.
2. Organizations, merchant wallet ownership proof, customers, and invoice lifecycle.
3. Quote adapters, USDC and USDT selection, Solana Pay checkout, and expiry cutoff slots.
4. Reconciliation, exceptions, allocations, functional-currency ledger, and wallet cutover.
5. Webhook outbox, evidence manifests, refunds, accounting exports, and hosted dashboard.

The current plan proves the open-core contract on which those plans depend.

## File structure

### Repository files

- package.json: root scripts, tool versions, and workspace metadata.
- pnpm-workspace.yaml: workspace package discovery.
- tsconfig.base.json: shared strict TypeScript rules.
- .gitignore: generated files and local secrets.
- .prettierignore: generated directories excluded from formatting.
- README.md: project positioning and conformance quick start.
- LICENSE: Apache-2.0 project notice.
- .github/workflows/ci.yml: reproducible install, checks, build, and conformance run.

### PayOps Core package

- packages/core/package.json: package exports, scripts, and pinned runtime dependencies.
- packages/core/tsconfig.json: editor, test, and no-emit type-check configuration.
- packages/core/tsconfig.build.json: declaration and JavaScript build configuration.
- packages/core/src/index.ts: public package exports.
- packages/core/src/domain/constants.ts: canonical clusters, mints, decimals, and token program.
- packages/core/src/domain/types.ts: parsed event, account metadata, and verification-report contracts.
- packages/core/src/fixtures/schema.ts: runtime schema for fixture and raw RPC data.
- packages/core/src/fixtures/load-fixture.ts: JSON file loading and schema validation.
- packages/core/src/solana/compiled-message.ts: static and loaded account metadata resolution.
- packages/core/src/solana/transfer-checked.ts: base58 and legacy SPL TransferChecked data decoding.
- packages/core/src/solana/parse-transaction.ts: outer and inner instruction event parsing.
- packages/core/src/verify/verify-payment.ts: deterministic payment checks and report construction.
- packages/core/src/conformance.ts: fixture-to-report orchestration.
- packages/core/src/canonical-json.ts: recursive stable-key JSON serialization.
- packages/core/src/cli.ts: command-line interface and exit codes.

### Tests and fixtures

- packages/core/test/constants.test.ts: canonical allowlist contract.
- packages/core/test/fixture-schema.test.ts: valid and invalid fixture behavior.
- packages/core/test/compiled-message.test.ts: signer and writability resolution.
- packages/core/test/transfer-checked.test.ts: binary instruction decoding.
- packages/core/test/parse-transaction.test.ts: event identity and reference parsing.
- packages/core/test/verify-payment.test.ts: complete passing report and targeted failures.
- packages/core/test/conformance.test.ts: deterministic end-to-end output.
- fixtures/v0.1/usdc-transfer-checked-finalized.json: canonical raw RPC vertical-slice fixture.

---

### Task 1: Establish the workspace and canonical asset contract

**Files:**

- Create: package.json
- Create: pnpm-workspace.yaml
- Create: tsconfig.base.json
- Create: .gitignore
- Create: .prettierignore
- Create: LICENSE
- Create: packages/core/package.json
- Create: packages/core/tsconfig.json
- Create: packages/core/tsconfig.build.json
- Create: packages/core/test/constants.test.ts
- Create: packages/core/src/domain/constants.ts
- Create: packages/core/src/index.ts

**Interfaces:**

- Produces: LEGACY_TOKEN_PROGRAM_ADDRESS, MAINNET_USDC, MAINNET_USDT, SUPPORTED_MAINNET_ASSETS.
- Consumes: no earlier task.

- [ ] **Step 1: Create the workspace manifests and failing canonical-asset test**

Create package.json:

    {
      "name": "solana-payment-ops",
      "private": true,
      "version": "0.0.0",
      "packageManager": "pnpm@11.15.0",
      "engines": {
        "node": ">=22.18.0"
      },
      "scripts": {
        "build": "pnpm -r build",
        "check": "pnpm format:check && pnpm typecheck && pnpm test",
        "format": "prettier --write .",
        "format:check": "prettier --check .",
        "test": "pnpm -r test",
        "typecheck": "pnpm -r typecheck"
      },
      "devDependencies": {
        "@types/node": "22.20.1",
        "prettier": "3.9.6",
        "typescript": "7.0.2"
      }
    }

Create pnpm-workspace.yaml:

    packages:
      - packages/*

Create tsconfig.base.json:

    {
      "compilerOptions": {
        "declaration": true,
        "declarationMap": true,
        "exactOptionalPropertyTypes": true,
        "forceConsistentCasingInFileNames": true,
        "lib": ["ES2022"],
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "noFallthroughCasesInSwitch": true,
        "noImplicitOverride": true,
        "noUncheckedIndexedAccess": true,
        "sourceMap": true,
        "strict": true,
        "target": "ES2022",
        "verbatimModuleSyntax": true
      }
    }

Create .gitignore:

    .env
    .env.*
    !.env.example
    .DS_Store
    coverage/
    dist/
    node_modules/
    *.tsbuildinfo

Create .prettierignore:

    coverage
    dist
    node_modules
    pnpm-lock.yaml

Create LICENSE:

    Apache License 2.0

    Copyright 2026 Gautam Manchandani

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        https://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

Create packages/core/package.json:

    {
      "name": "@payops/core",
      "version": "0.0.1",
      "description": "Deterministic Solana payment parsing and verification primitives",
      "type": "module",
      "license": "Apache-2.0",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        }
      },
      "files": ["dist"],
      "scripts": {
        "build": "tsc -p tsconfig.build.json",
        "test": "vitest run",
        "typecheck": "tsc -p tsconfig.json"
      },
      "dependencies": {
        "@solana/kit": "7.0.0",
        "bs58": "6.0.0",
        "zod": "4.4.3"
      },
      "devDependencies": {
        "tsx": "4.23.9",
        "vitest": "4.1.10"
      }
    }

Create packages/core/tsconfig.json:

    {
      "extends": "../../tsconfig.base.json",
      "compilerOptions": {
        "noEmit": true,
        "types": ["node", "vitest/globals"]
      },
      "include": ["src/**/*.ts", "test/**/*.ts"]
    }

Create packages/core/tsconfig.build.json:

    {
      "extends": "./tsconfig.json",
      "compilerOptions": {
        "noEmit": false,
        "outDir": "dist",
        "rootDir": "src",
        "types": ["node"]
      },
      "exclude": ["test/**/*.ts"]
    }

Create packages/core/test/constants.test.ts:

    import { describe, expect, it } from 'vitest';
    import {
      LEGACY_TOKEN_PROGRAM_ADDRESS,
      MAINNET_USDC,
      MAINNET_USDT,
      SUPPORTED_MAINNET_ASSETS,
    } from '../src/index.js';

    describe('canonical asset allowlist', () => {
      it('pins canonical mainnet USDC and USDT to the legacy token program', () => {
        expect(String(LEGACY_TOKEN_PROGRAM_ADDRESS)).toBe(
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        );
        expect(String(MAINNET_USDC.mint)).toBe(
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        );
        expect(String(MAINNET_USDT.mint)).toBe(
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        );
        expect(MAINNET_USDC.decimals).toBe(6);
        expect(MAINNET_USDT.decimals).toBe(6);
        expect(SUPPORTED_MAINNET_ASSETS).toEqual({
          USDC: MAINNET_USDC,
          USDT: MAINNET_USDT,
        });
      });
    });

- [ ] **Step 2: Install dependencies and verify the test fails**

Run:

    pnpm install
    pnpm --filter @payops/core test -- constants.test.ts

Expected: installation succeeds and the test fails because packages/core/src/index.ts does not exist.

- [ ] **Step 3: Implement the exact asset allowlist**

Create packages/core/src/domain/constants.ts:

    import { address } from '@solana/kit';

    export const LEGACY_TOKEN_PROGRAM_ADDRESS = address(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );

    export const MAINNET_USDC = {
      symbol: 'USDC',
      mint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      tokenProgram: LEGACY_TOKEN_PROGRAM_ADDRESS,
      decimals: 6,
    } as const;

    export const MAINNET_USDT = {
      symbol: 'USDT',
      mint: address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
      tokenProgram: LEGACY_TOKEN_PROGRAM_ADDRESS,
      decimals: 6,
    } as const;

    export const SUPPORTED_MAINNET_ASSETS = {
      USDC: MAINNET_USDC,
      USDT: MAINNET_USDT,
    } as const;

Create packages/core/src/index.ts:

    export {
      LEGACY_TOKEN_PROGRAM_ADDRESS,
      MAINNET_USDC,
      MAINNET_USDT,
      SUPPORTED_MAINNET_ASSETS,
    } from './domain/constants.js';

- [ ] **Step 4: Run checks and verify the test passes**

Run:

    pnpm --filter @payops/core test -- constants.test.ts
    pnpm --filter @payops/core typecheck
    pnpm --filter @payops/core build

Expected: one test passes, TypeScript reports no errors, and packages/core/dist/index.js exists.

- [ ] **Step 5: Commit the workspace foundation**

Run:

    git add .gitignore .prettierignore LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages/core
    git commit -m "chore: establish PayOps core workspace"

Expected: one commit containing the reproducible workspace and canonical asset test.

---

### Task 2: Define and validate the raw RPC fixture contract

**Files:**

- Create: packages/core/src/fixtures/schema.ts
- Create: packages/core/src/fixtures/load-fixture.ts
- Create: packages/core/test/fixture-schema.test.ts
- Create: fixtures/v0.1/usdc-transfer-checked-finalized.json
- Modify: packages/core/src/index.ts

**Interfaces:**

- Produces: PaymentFixtureSchema, PaymentFixture, loadPaymentFixture(path).
- Consumes: canonical addresses from Task 1.

- [ ] **Step 1: Write the valid-load and invalid-address tests**

Create packages/core/test/fixture-schema.test.ts:

    import { fileURLToPath } from 'node:url';
    import { describe, expect, it } from 'vitest';
    import {
      loadPaymentFixture,
      PaymentFixtureSchema,
    } from '../src/index.js';

    const fixturePath = fileURLToPath(
      new URL('../../../fixtures/v0.1/usdc-transfer-checked-finalized.json', import.meta.url),
    );

    describe('PaymentFixtureSchema', () => {
      it('loads the canonical USDC fixture without losing integer strings', async () => {
        const fixture = await loadPaymentFixture(fixturePath);

        expect(fixture.fixtureVersion).toBe('0.1');
        expect(fixture.expectation.amountBaseUnits).toBe('12500000');
        expect(
          fixture.rpcTransaction.meta.postTokenBalances[1]?.uiTokenAmount.amount,
        ).toBe('12500000');
      });

      it('rejects a malformed Solana reference', async () => {
        const fixture = await loadPaymentFixture(fixturePath);
        const result = PaymentFixtureSchema.safeParse({
          ...fixture,
          expectation: {
            ...fixture.expectation,
            reference: 'not-a-solana-address',
          },
        });

        expect(result.success).toBe(false);
      });
    });

Create fixtures/v0.1/usdc-transfer-checked-finalized.json:

    {
      "fixtureVersion": "0.1",
      "name": "canonical finalized USDC TransferChecked with one reference",
      "expectation": {
        "cluster": "mainnet-beta",
        "recipientOwner": "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym",
        "destinationTokenAccount": "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "amountBaseUnits": "12500000",
        "decimals": 6,
        "reference": "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
        "requiredCommitment": "finalized"
      },
      "rpcTransaction": {
        "cluster": "mainnet-beta",
        "commitment": "finalized",
        "signature": "1111111111111111111111111111111111111111111111111111111111111111",
        "slot": 345678901,
        "blockTime": 1786000000,
        "transaction": {
          "message": {
            "header": {
              "numRequiredSignatures": 1,
              "numReadonlySignedAccounts": 0,
              "numReadonlyUnsignedAccounts": 3
            },
            "accountKeys": [
              "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
              "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
              "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
              "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
              "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            ],
            "instructions": [
              {
                "programIdIndex": 5,
                "accounts": [1, 3, 2, 0, 4],
                "data": "gX7kDtBjAyK57"
              }
            ]
          }
        },
        "meta": {
          "err": null,
          "loadedAddresses": {
            "writable": [],
            "readonly": []
          },
          "innerInstructions": [],
          "preTokenBalances": [
            {
              "accountIndex": 1,
              "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "owner": "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
              "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              "uiTokenAmount": {
                "amount": "20000000",
                "decimals": 6
              }
            },
            {
              "accountIndex": 2,
              "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "owner": "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym",
              "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              "uiTokenAmount": {
                "amount": "0",
                "decimals": 6
              }
            }
          ],
          "postTokenBalances": [
            {
              "accountIndex": 1,
              "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "owner": "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
              "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              "uiTokenAmount": {
                "amount": "7500000",
                "decimals": 6
              }
            },
            {
              "accountIndex": 2,
              "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "owner": "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym",
              "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              "uiTokenAmount": {
                "amount": "12500000",
                "decimals": 6
              }
            }
          ]
        }
      }
    }

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

    pnpm --filter @payops/core test -- fixture-schema.test.ts

Expected: failure because loadPaymentFixture and PaymentFixtureSchema are not exported.

- [ ] **Step 3: Implement the fixture schema and loader**

Create packages/core/src/fixtures/schema.ts:

    import { address } from '@solana/kit';
    import bs58 from 'bs58';
    import { z } from 'zod';

    const solanaAddressSchema = z.string().refine(
      (value) => {
        try {
          address(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid Solana address' },
    );

    const signatureSchema = z.string().refine(
      (value) => {
        try {
          return bs58.decode(value).length === 64;
        } catch {
          return false;
        }
      },
      { message: 'Invalid Solana transaction signature' },
    );

    const baseUnitStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
    const commitmentSchema = z.enum(['confirmed', 'finalized']);

    const compiledInstructionSchema = z
      .object({
        programIdIndex: z.number().int().nonnegative(),
        accounts: z.array(z.number().int().nonnegative()),
        data: z.string().min(1),
        stackHeight: z.number().int().nonnegative().nullable().optional(),
      })
      .passthrough();

    const tokenBalanceSchema = z
      .object({
        accountIndex: z.number().int().nonnegative(),
        mint: solanaAddressSchema,
        owner: solanaAddressSchema.optional(),
        programId: solanaAddressSchema.optional(),
        uiTokenAmount: z
          .object({
            amount: baseUnitStringSchema,
            decimals: z.number().int().nonnegative(),
          })
          .passthrough(),
      })
      .passthrough();

    export const PaymentFixtureSchema = z
      .object({
        fixtureVersion: z.literal('0.1'),
        name: z.string().min(1),
        expectation: z
          .object({
            cluster: z.literal('mainnet-beta'),
            recipientOwner: solanaAddressSchema,
            destinationTokenAccount: solanaAddressSchema,
            mint: solanaAddressSchema,
            tokenProgram: solanaAddressSchema,
            amountBaseUnits: baseUnitStringSchema,
            decimals: z.number().int().nonnegative(),
            reference: solanaAddressSchema,
            requiredCommitment: commitmentSchema,
          })
          .strict(),
        rpcTransaction: z
          .object({
            cluster: z.literal('mainnet-beta'),
            commitment: commitmentSchema,
            signature: signatureSchema,
            slot: z.number().int().nonnegative(),
            blockTime: z.number().int().nullable(),
            transaction: z
              .object({
                message: z
                  .object({
                    header: z
                      .object({
                        numRequiredSignatures: z.number().int().nonnegative(),
                        numReadonlySignedAccounts: z.number().int().nonnegative(),
                        numReadonlyUnsignedAccounts: z.number().int().nonnegative(),
                      })
                      .strict(),
                    accountKeys: z.array(solanaAddressSchema),
                    instructions: z.array(compiledInstructionSchema),
                  })
                  .passthrough(),
              })
              .passthrough(),
            meta: z
              .object({
                err: z.union([
                  z.null(),
                  z.record(z.string(), z.unknown()),
                ]),
                loadedAddresses: z
                  .object({
                    writable: z.array(solanaAddressSchema),
                    readonly: z.array(solanaAddressSchema),
                  })
                  .optional(),
                innerInstructions: z
                  .array(
                    z
                      .object({
                        index: z.number().int().nonnegative(),
                        instructions: z.array(compiledInstructionSchema),
                      })
                      .passthrough(),
                  )
                  .nullable()
                  .optional(),
                preTokenBalances: z.array(tokenBalanceSchema),
                postTokenBalances: z.array(tokenBalanceSchema),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .strict();

    export type PaymentFixture = z.infer<typeof PaymentFixtureSchema>;
    export type CompiledInstruction =
      PaymentFixture['rpcTransaction']['transaction']['message']['instructions'][number];

Create packages/core/src/fixtures/load-fixture.ts:

    import { readFile } from 'node:fs/promises';
    import {
      PaymentFixtureSchema,
      type PaymentFixture,
    } from './schema.js';

    export async function loadPaymentFixture(path: string): Promise<PaymentFixture> {
      const json = await readFile(path, 'utf8');
      return PaymentFixtureSchema.parse(JSON.parse(json));
    }

Append to packages/core/src/index.ts:

    export {
      PaymentFixtureSchema,
      type CompiledInstruction,
      type PaymentFixture,
    } from './fixtures/schema.js';
    export { loadPaymentFixture } from './fixtures/load-fixture.js';

- [ ] **Step 4: Run the fixture tests and type check**

Run:

    pnpm --filter @payops/core test -- fixture-schema.test.ts
    pnpm --filter @payops/core typecheck

Expected: two tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the fixture contract**

Run:

    git add fixtures packages/core/src packages/core/test/fixture-schema.test.ts
    git commit -m "feat: define payment conformance fixture"

Expected: one commit containing the schema, loader, and canonical raw RPC fixture.

---

### Task 3: Decode compiled-message metadata and TransferChecked data

**Files:**

- Create: packages/core/src/domain/types.ts
- Create: packages/core/src/solana/compiled-message.ts
- Create: packages/core/src/solana/transfer-checked.ts
- Create: packages/core/test/compiled-message.test.ts
- Create: packages/core/test/transfer-checked.test.ts
- Modify: packages/core/src/index.ts

**Interfaces:**

- Produces: ResolvedAccountKey, DecodedTransferChecked, resolveAccountKeys(message, loadedAddresses), decodeTransferChecked(data).
- Consumes: PaymentFixture and CompiledInstruction from Task 2.

- [ ] **Step 1: Write failing account-resolution and instruction-decoding tests**

Create packages/core/test/compiled-message.test.ts:

    import { fileURLToPath } from 'node:url';
    import { describe, expect, it } from 'vitest';
    import {
      loadPaymentFixture,
      resolveAccountKeys,
    } from '../src/index.js';

    const fixturePath = fileURLToPath(
      new URL('../../../fixtures/v0.1/usdc-transfer-checked-finalized.json', import.meta.url),
    );

    describe('resolveAccountKeys', () => {
      it('derives signer and writable metadata from the message header', async () => {
        const fixture = await loadPaymentFixture(fixturePath);
        const message = fixture.rpcTransaction.transaction.message;
        const accounts = resolveAccountKeys(
          message,
          fixture.rpcTransaction.meta.loadedAddresses,
        );

        expect(accounts.map(({ signer, writable, source }) => ({
          signer,
          writable,
          source,
        }))).toEqual([
          { signer: true, writable: true, source: 'static' },
          { signer: false, writable: true, source: 'static' },
          { signer: false, writable: true, source: 'static' },
          { signer: false, writable: false, source: 'static' },
          { signer: false, writable: false, source: 'static' },
          { signer: false, writable: false, source: 'static' },
        ]);
      });
    });

Create packages/core/test/transfer-checked.test.ts:

    import { describe, expect, it } from 'vitest';
    import { decodeTransferChecked } from '../src/index.js';

    describe('decodeTransferChecked', () => {
      it('decodes u64 amount and decimals without floating point', () => {
        expect(decodeTransferChecked('gX7kDtBjAyK57')).toEqual({
          amountBaseUnits: 12500000n,
          decimals: 6,
        });
      });

      it('rejects non-TransferChecked data', () => {
        expect(() => decodeTransferChecked('2')).toThrow(
          'Unsupported token instruction discriminator',
        );
      });
    });

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

    pnpm --filter @payops/core test -- compiled-message.test.ts transfer-checked.test.ts

Expected: failure because resolveAccountKeys and decodeTransferChecked do not exist.

- [ ] **Step 3: Implement account resolution and binary decoding**

Create packages/core/src/domain/types.ts:

    export interface ResolvedAccountKey {
      readonly address: string;
      readonly signer: boolean;
      readonly writable: boolean;
      readonly source: 'static' | 'loaded-writable' | 'loaded-readonly';
    }

    export interface DecodedTransferChecked {
      readonly amountBaseUnits: bigint;
      readonly decimals: number;
    }

Create packages/core/src/solana/compiled-message.ts:

    import type { PaymentFixture } from '../fixtures/schema.js';
    import type { ResolvedAccountKey } from '../domain/types.js';

    type Message = PaymentFixture['rpcTransaction']['transaction']['message'];
    type LoadedAddresses = PaymentFixture['rpcTransaction']['meta']['loadedAddresses'];

    export function resolveAccountKeys(
      message: Message,
      loadedAddresses: LoadedAddresses,
    ): readonly ResolvedAccountKey[] {
      const {
        numRequiredSignatures,
        numReadonlySignedAccounts,
        numReadonlyUnsignedAccounts,
      } = message.header;
      const writableSignerCount =
        numRequiredSignatures - numReadonlySignedAccounts;
      const writableUnsignedEnd =
        message.accountKeys.length - numReadonlyUnsignedAccounts;

      const staticKeys = message.accountKeys.map((accountAddress, index) => {
        const signer = index < numRequiredSignatures;
        const writable = signer
          ? index < writableSignerCount
          : index < writableUnsignedEnd;

        return {
          address: accountAddress,
          signer,
          writable,
          source: 'static' as const,
        };
      });

      const writableLoaded = (loadedAddresses?.writable ?? []).map(
        (accountAddress) => ({
          address: accountAddress,
          signer: false,
          writable: true,
          source: 'loaded-writable' as const,
        }),
      );
      const readonlyLoaded = (loadedAddresses?.readonly ?? []).map(
        (accountAddress) => ({
          address: accountAddress,
          signer: false,
          writable: false,
          source: 'loaded-readonly' as const,
        }),
      );

      return [...staticKeys, ...writableLoaded, ...readonlyLoaded];
    }

Create packages/core/src/solana/transfer-checked.ts:

    import bs58 from 'bs58';
    import type { DecodedTransferChecked } from '../domain/types.js';

    const TRANSFER_CHECKED_DISCRIMINATOR = 12;
    const TRANSFER_CHECKED_DATA_LENGTH = 10;

    export function decodeTransferChecked(data: string): DecodedTransferChecked {
      const bytes = bs58.decode(data);

      if (bytes[0] !== TRANSFER_CHECKED_DISCRIMINATOR) {
        throw new Error('Unsupported token instruction discriminator');
      }
      if (bytes.length !== TRANSFER_CHECKED_DATA_LENGTH) {
        throw new Error('Invalid TransferChecked instruction length');
      }

      let amountBaseUnits = 0n;
      for (let index = 0; index < 8; index += 1) {
        const byte = bytes[index + 1];
        if (byte === undefined) {
          throw new Error('Invalid TransferChecked amount encoding');
        }
        amountBaseUnits |= BigInt(byte) << BigInt(index * 8);
      }

      const decimals = bytes[9];
      if (decimals === undefined) {
        throw new Error('Missing TransferChecked decimals');
      }

      return { amountBaseUnits, decimals };
    }

Append to packages/core/src/index.ts:

    export type {
      DecodedTransferChecked,
      ResolvedAccountKey,
    } from './domain/types.js';
    export { resolveAccountKeys } from './solana/compiled-message.js';
    export { decodeTransferChecked } from './solana/transfer-checked.js';

- [ ] **Step 4: Verify primitive tests and all earlier tests pass**

Run:

    pnpm --filter @payops/core test
    pnpm --filter @payops/core typecheck

Expected: six tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the Solana primitives**

Run:

    git add packages/core/src packages/core/test/compiled-message.test.ts packages/core/test/transfer-checked.test.ts
    git commit -m "feat: decode Solana compiled transfer data"

Expected: one commit containing pure, deterministic instruction primitives.

---

### Task 4: Parse outer and inner payment events

**Files:**

- Modify: packages/core/src/domain/types.ts
- Create: packages/core/src/solana/parse-transaction.ts
- Create: packages/core/test/parse-transaction.test.ts
- Modify: packages/core/src/index.ts

**Interfaces:**

- Produces: ParsedTransfer, parseTransferCheckedEvents(fixture).
- Consumes: PaymentFixture, resolveAccountKeys, decodeTransferChecked, and LEGACY_TOKEN_PROGRAM_ADDRESS.

- [ ] **Step 1: Write the failing event-parser test**

Create packages/core/test/parse-transaction.test.ts:

    import { fileURLToPath } from 'node:url';
    import { describe, expect, it } from 'vitest';
    import {
      loadPaymentFixture,
      parseTransferCheckedEvents,
    } from '../src/index.js';

    const fixturePath = fileURLToPath(
      new URL('../../../fixtures/v0.1/usdc-transfer-checked-finalized.json', import.meta.url),
    );

    describe('parseTransferCheckedEvents', () => {
      it('creates a stable instruction-level event with a reference', async () => {
        const fixture = await loadPaymentFixture(fixturePath);
        const events = parseTransferCheckedEvents(fixture);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
          eventId:
            'mainnet-beta:1111111111111111111111111111111111111111111111111111111111111111:0:outer',
          signature:
            '1111111111111111111111111111111111111111111111111111111111111111',
          slot: 345678901,
          outerInstructionIndex: 0,
          innerInstructionIndex: null,
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          sourceTokenAccount: '8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e',
          sourceAccountIndex: 1,
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          destinationTokenAccount:
            'Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM',
          destinationAccountIndex: 2,
          authority: '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
          amountBaseUnits: '12500000',
          decimals: 6,
          references: ['Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4'],
          unsupportedExtraAccounts: [],
        });
      });
    });

- [ ] **Step 2: Run the parser test and verify it fails**

Run:

    pnpm --filter @payops/core test -- parse-transaction.test.ts

Expected: failure because parseTransferCheckedEvents is not defined.

- [ ] **Step 3: Implement outer and inner instruction parsing**

Append to packages/core/src/domain/types.ts:

    export interface ParsedTransfer {
      readonly eventId: string;
      readonly signature: string;
      readonly slot: number;
      readonly outerInstructionIndex: number;
      readonly innerInstructionIndex: number | null;
      readonly programId: string;
      readonly sourceTokenAccount: string;
      readonly sourceAccountIndex: number;
      readonly mint: string;
      readonly destinationTokenAccount: string;
      readonly destinationAccountIndex: number;
      readonly authority: string;
      readonly amountBaseUnits: string;
      readonly decimals: number;
      readonly references: readonly string[];
      readonly unsupportedExtraAccounts: readonly string[];
    }

Create packages/core/src/solana/parse-transaction.ts:

    import { LEGACY_TOKEN_PROGRAM_ADDRESS } from '../domain/constants.js';
    import type { ParsedTransfer } from '../domain/types.js';
    import type {
      CompiledInstruction,
      PaymentFixture,
    } from '../fixtures/schema.js';
    import { resolveAccountKeys } from './compiled-message.js';
    import { decodeTransferChecked } from './transfer-checked.js';

    interface InstructionLocation {
      readonly instruction: CompiledInstruction;
      readonly outerInstructionIndex: number;
      readonly innerInstructionIndex: number | null;
    }

    export function parseTransferCheckedEvents(
      fixture: PaymentFixture,
    ): readonly ParsedTransfer[] {
      const { rpcTransaction } = fixture;
      const message = rpcTransaction.transaction.message;
      const accountKeys = resolveAccountKeys(
        message,
        rpcTransaction.meta.loadedAddresses,
      );

      const outerInstructions = message.instructions.map(
        (instruction, outerInstructionIndex): InstructionLocation => ({
          instruction,
          outerInstructionIndex,
          innerInstructionIndex: null,
        }),
      );
      const innerInstructions = (
        rpcTransaction.meta.innerInstructions ?? []
      ).flatMap(({ index, instructions }) =>
        instructions.map(
          (instruction, innerInstructionIndex): InstructionLocation => ({
            instruction,
            outerInstructionIndex: index,
            innerInstructionIndex,
          }),
        ),
      );

      return [...outerInstructions, ...innerInstructions].flatMap((location) => {
        const { instruction } = location;
        const program = accountKeys[instruction.programIdIndex];
        if (program?.address !== String(LEGACY_TOKEN_PROGRAM_ADDRESS)) {
          return [];
        }

        let decoded;
        try {
          decoded = decodeTransferChecked(instruction.data);
        } catch {
          return [];
        }

        const instructionAccounts = instruction.accounts.map((index) => ({
          index,
          meta: accountKeys[index],
        }));
        const source = instructionAccounts[0];
        const mint = instructionAccounts[1];
        const destination = instructionAccounts[2];
        const authority = instructionAccounts[3];

        if (
          source?.meta === undefined ||
          mint?.meta === undefined ||
          destination?.meta === undefined ||
          authority?.meta === undefined
        ) {
          return [];
        }

        const extras = instructionAccounts.slice(4);
        const references = extras
          .filter(({ meta }) => meta !== undefined && !meta.signer && !meta.writable)
          .map(({ meta }) => meta?.address)
          .filter((value): value is string => value !== undefined);
        const unsupportedExtraAccounts = extras
          .filter(({ meta }) => meta === undefined || meta.signer || meta.writable)
          .map(({ meta }) => meta?.address ?? 'unresolved');
        const innerPart =
          location.innerInstructionIndex === null
            ? 'outer'
            : String(location.innerInstructionIndex);

        return [
          {
            eventId:
              rpcTransaction.cluster +
              ':' +
              rpcTransaction.signature +
              ':' +
              String(location.outerInstructionIndex) +
              ':' +
              innerPart,
            signature: rpcTransaction.signature,
            slot: rpcTransaction.slot,
            outerInstructionIndex: location.outerInstructionIndex,
            innerInstructionIndex: location.innerInstructionIndex,
            programId: program.address,
            sourceTokenAccount: source.meta.address,
            sourceAccountIndex: source.index,
            mint: mint.meta.address,
            destinationTokenAccount: destination.meta.address,
            destinationAccountIndex: destination.index,
            authority: authority.meta.address,
            amountBaseUnits: decoded.amountBaseUnits.toString(),
            decimals: decoded.decimals,
            references,
            unsupportedExtraAccounts,
          },
        ];
      });
    }

Append to packages/core/src/index.ts:

    export type { ParsedTransfer } from './domain/types.js';
    export { parseTransferCheckedEvents } from './solana/parse-transaction.js';

- [ ] **Step 4: Run parser, earlier tests, and type check**

Run:

    pnpm --filter @payops/core test
    pnpm --filter @payops/core typecheck

Expected: seven tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit instruction-level parsing**

Run:

    git add packages/core/src packages/core/test/parse-transaction.test.ts
    git commit -m "feat: parse instruction-level payment events"

Expected: one commit with stable outer and inner instruction coordinates.

---

### Task 5: Verify exact payment semantics and balance conservation

**Files:**

- Modify: packages/core/src/domain/types.ts
- Create: packages/core/src/verify/verify-payment.ts
- Create: packages/core/test/verify-payment.test.ts
- Modify: packages/core/src/index.ts

**Interfaces:**

- Produces: VerificationCode, VerificationCheck, VerificationReport, verifyPayment(fixture, transfer, allTransfers).
- Consumes: PaymentFixture and ParsedTransfer.

- [ ] **Step 1: Write passing-fixture and wrong-mint failure tests**

Create packages/core/test/verify-payment.test.ts:

    import { fileURLToPath } from 'node:url';
    import { describe, expect, it } from 'vitest';
    import {
      loadPaymentFixture,
      parseTransferCheckedEvents,
      verifyPayment,
    } from '../src/index.js';

    const fixturePath = fileURLToPath(
      new URL('../../../fixtures/v0.1/usdc-transfer-checked-finalized.json', import.meta.url),
    );

    describe('verifyPayment', () => {
      it('passes every check for the canonical finalized USDC payment', async () => {
        const fixture = await loadPaymentFixture(fixturePath);
        const transfers = parseTransferCheckedEvents(fixture);
        const transfer = transfers[0];
        if (transfer === undefined) {
          throw new Error('Expected one parsed transfer');
        }

        const report = verifyPayment(fixture, transfer, transfers);

        expect(report.verified).toBe(true);
        expect(report.checks.every((check) => check.passed)).toBe(true);
        expect(report.checks.map((check) => check.code)).toEqual([
          'transaction_success',
          'cluster',
          'commitment',
          'token_program',
          'mint',
          'destination',
          'destination_owner',
          'destination_token_program',
          'destination_balance_mint',
          'amount',
          'decimals',
          'reference',
          'unambiguous_reference_accounts',
          'non_self_transfer',
          'destination_balance_delta',
        ]);
      });

      it('fails closed when the expected mint differs', async () => {
        const fixture = await loadPaymentFixture(fixturePath);
        const wrongMintFixture = {
          ...fixture,
          expectation: {
            ...fixture.expectation,
            mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          },
        };
        const transfers = parseTransferCheckedEvents(wrongMintFixture);
        const transfer = transfers[0];
        if (transfer === undefined) {
          throw new Error('Expected one parsed transfer');
        }

        const report = verifyPayment(wrongMintFixture, transfer, transfers);
        const mintCheck = report.checks.find((check) => check.code === 'mint');

        expect(report.verified).toBe(false);
        expect(mintCheck?.passed).toBe(false);
      });
    });

- [ ] **Step 2: Run the verification tests and verify they fail**

Run:

    pnpm --filter @payops/core test -- verify-payment.test.ts

Expected: failure because verifyPayment is not defined.

- [ ] **Step 3: Implement all deterministic verification checks**

Append to packages/core/src/domain/types.ts:

    export type VerificationCode =
      | 'transaction_success'
      | 'cluster'
      | 'commitment'
      | 'token_program'
      | 'mint'
      | 'destination'
      | 'destination_owner'
      | 'destination_token_program'
      | 'destination_balance_mint'
      | 'amount'
      | 'decimals'
      | 'reference'
      | 'unambiguous_reference_accounts'
      | 'non_self_transfer'
      | 'destination_balance_delta';

    export interface VerificationCheck {
      readonly code: VerificationCode;
      readonly passed: boolean;
      readonly expected: string;
      readonly actual: string;
    }

    export interface VerificationReport {
      readonly schemaVersion: '0.1';
      readonly fixtureName: string;
      readonly eventId: string;
      readonly signature: string;
      readonly slot: number;
      readonly verified: boolean;
      readonly checks: readonly VerificationCheck[];
      readonly transfer: ParsedTransfer;
    }

Create packages/core/src/verify/verify-payment.ts:

    import type {
      ParsedTransfer,
      VerificationCheck,
      VerificationCode,
      VerificationReport,
    } from '../domain/types.js';
    import type { PaymentFixture } from '../fixtures/schema.js';

    function makeCheck(
      code: VerificationCode,
      passed: boolean,
      expected: string,
      actual: string,
    ): VerificationCheck {
      return { code, passed, expected, actual };
    }

    function commitmentRank(commitment: 'confirmed' | 'finalized'): number {
      return commitment === 'finalized' ? 2 : 1;
    }

    function tokenBalance(
      balances: PaymentFixture['rpcTransaction']['meta']['postTokenBalances'],
      accountIndex: number,
    ) {
      return balances.find((balance) => balance.accountIndex === accountIndex);
    }

    function aggregateDestinationDelta(
      transfers: readonly ParsedTransfer[],
      destinationAccountIndex: number,
      mint: string,
    ): bigint {
      return transfers.reduce((net, transfer) => {
        if (transfer.mint !== mint) {
          return net;
        }
        const credit =
          transfer.destinationAccountIndex === destinationAccountIndex
            ? BigInt(transfer.amountBaseUnits)
            : 0n;
        const debit =
          transfer.sourceAccountIndex === destinationAccountIndex
            ? BigInt(transfer.amountBaseUnits)
            : 0n;
        return net + credit - debit;
      }, 0n);
    }

    export function verifyPayment(
      fixture: PaymentFixture,
      transfer: ParsedTransfer,
      allTransfers: readonly ParsedTransfer[],
    ): VerificationReport {
      const { expectation, rpcTransaction } = fixture;
      const preBalance = tokenBalance(
        rpcTransaction.meta.preTokenBalances,
        transfer.destinationAccountIndex,
      );
      const postBalance = tokenBalance(
        rpcTransaction.meta.postTokenBalances,
        transfer.destinationAccountIndex,
      );
      const actualBalanceDelta =
        BigInt(postBalance?.uiTokenAmount.amount ?? '0') -
        BigInt(preBalance?.uiTokenAmount.amount ?? '0');
      const parsedBalanceDelta = aggregateDestinationDelta(
        allTransfers,
        transfer.destinationAccountIndex,
        transfer.mint,
      );

      const checks: readonly VerificationCheck[] = [
        makeCheck(
          'transaction_success',
          rpcTransaction.meta.err === null,
          'null',
          JSON.stringify(rpcTransaction.meta.err) ?? 'unserializable',
        ),
        makeCheck(
          'cluster',
          rpcTransaction.cluster === expectation.cluster,
          expectation.cluster,
          rpcTransaction.cluster,
        ),
        makeCheck(
          'commitment',
          commitmentRank(rpcTransaction.commitment) >=
            commitmentRank(expectation.requiredCommitment),
          expectation.requiredCommitment,
          rpcTransaction.commitment,
        ),
        makeCheck(
          'token_program',
          transfer.programId === expectation.tokenProgram,
          expectation.tokenProgram,
          transfer.programId,
        ),
        makeCheck(
          'mint',
          transfer.mint === expectation.mint,
          expectation.mint,
          transfer.mint,
        ),
        makeCheck(
          'destination',
          transfer.destinationTokenAccount ===
            expectation.destinationTokenAccount,
          expectation.destinationTokenAccount,
          transfer.destinationTokenAccount,
        ),
        makeCheck(
          'destination_owner',
          postBalance?.owner === expectation.recipientOwner,
          expectation.recipientOwner,
          postBalance?.owner ?? 'missing',
        ),
        makeCheck(
          'destination_token_program',
          postBalance?.programId === expectation.tokenProgram,
          expectation.tokenProgram,
          postBalance?.programId ?? 'missing',
        ),
        makeCheck(
          'destination_balance_mint',
          postBalance?.mint === expectation.mint,
          expectation.mint,
          postBalance?.mint ?? 'missing',
        ),
        makeCheck(
          'amount',
          transfer.amountBaseUnits === expectation.amountBaseUnits,
          expectation.amountBaseUnits,
          transfer.amountBaseUnits,
        ),
        makeCheck(
          'decimals',
          transfer.decimals === expectation.decimals,
          String(expectation.decimals),
          String(transfer.decimals),
        ),
        makeCheck(
          'reference',
          transfer.references.includes(expectation.reference),
          expectation.reference,
          transfer.references.join(','),
        ),
        makeCheck(
          'unambiguous_reference_accounts',
          transfer.unsupportedExtraAccounts.length === 0,
          'none',
          transfer.unsupportedExtraAccounts.join(',') || 'none',
        ),
        makeCheck(
          'non_self_transfer',
          transfer.sourceAccountIndex !== transfer.destinationAccountIndex,
          'different source and destination',
          transfer.sourceAccountIndex === transfer.destinationAccountIndex
            ? 'same source and destination'
            : 'different source and destination',
        ),
        makeCheck(
          'destination_balance_delta',
          actualBalanceDelta === parsedBalanceDelta &&
            parsedBalanceDelta === BigInt(expectation.amountBaseUnits),
          expectation.amountBaseUnits,
          actualBalanceDelta.toString(),
        ),
      ];

      return {
        schemaVersion: '0.1',
        fixtureName: fixture.name,
        eventId: transfer.eventId,
        signature: transfer.signature,
        slot: transfer.slot,
        verified: checks.every((check) => check.passed),
        checks,
        transfer,
      };
    }

Append to packages/core/src/index.ts:

    export type {
      VerificationCheck,
      VerificationCode,
      VerificationReport,
    } from './domain/types.js';
    export { verifyPayment } from './verify/verify-payment.js';

- [ ] **Step 4: Run verification, full tests, type check, and build**

Run:

    pnpm --filter @payops/core test
    pnpm --filter @payops/core typecheck
    pnpm --filter @payops/core build

Expected: nine tests pass, TypeScript reports no errors, and the package builds.

- [ ] **Step 5: Commit the payment verifier**

Run:

    git add packages/core/src packages/core/test/verify-payment.test.ts
    git commit -m "feat: verify exact finalized payments"

Expected: one commit containing explicit, inspectable verification results.

---

### Task 6: Ship the deterministic conformance CLI and CI

**Files:**

- Create: packages/core/src/conformance.ts
- Create: packages/core/src/canonical-json.ts
- Create: packages/core/src/cli.ts
- Create: packages/core/test/conformance.test.ts
- Modify: packages/core/src/index.ts
- Modify: packages/core/package.json
- Modify: package.json
- Create: README.md
- Create: .github/workflows/ci.yml

**Interfaces:**

- Produces: ConformanceReport, evaluateFixture(fixture), stringifyCanonical(value), payops-conformance CLI.
- Consumes: loadPaymentFixture, parseTransferCheckedEvents, and verifyPayment.

- [ ] **Step 1: Write the failing deterministic-report test**

Create packages/core/test/conformance.test.ts:

    import { fileURLToPath } from 'node:url';
    import { describe, expect, it } from 'vitest';
    import {
      evaluateFixture,
      loadPaymentFixture,
      stringifyCanonical,
    } from '../src/index.js';

    const fixturePath = fileURLToPath(
      new URL('../../../fixtures/v0.1/usdc-transfer-checked-finalized.json', import.meta.url),
    );

    describe('conformance report', () => {
      it('produces stable passing JSON for the canonical fixture', async () => {
        const fixture = await loadPaymentFixture(fixturePath);
        const report = evaluateFixture(fixture);
        const first = stringifyCanonical(report);
        const second = stringifyCanonical(report);

        expect(report.passed).toBe(true);
        expect(report.reports).toHaveLength(1);
        expect(first).toBe(second);
        expect(first.endsWith('\n')).toBe(true);
        expect(first).toContain('"passed": true');
      });
    });

- [ ] **Step 2: Run the conformance test and verify it fails**

Run:

    pnpm --filter @payops/core test -- conformance.test.ts

Expected: failure because evaluateFixture and stringifyCanonical do not exist.

- [ ] **Step 3: Implement orchestration, canonical JSON, and CLI exit behavior**

Create packages/core/src/conformance.ts:

    import type { VerificationReport } from './domain/types.js';
    import type { PaymentFixture } from './fixtures/schema.js';
    import { parseTransferCheckedEvents } from './solana/parse-transaction.js';
    import { verifyPayment } from './verify/verify-payment.js';

    export interface ConformanceReport {
      readonly schemaVersion: '0.1';
      readonly fixtureName: string;
      readonly signature: string;
      readonly passed: boolean;
      readonly reports: readonly VerificationReport[];
    }

    export function evaluateFixture(
      fixture: PaymentFixture,
    ): ConformanceReport {
      const transfers = parseTransferCheckedEvents(fixture);
      const reports = transfers.map((transfer) =>
        verifyPayment(fixture, transfer, transfers),
      );

      return {
        schemaVersion: '0.1',
        fixtureName: fixture.name,
        signature: fixture.rpcTransaction.signature,
        passed: reports.length > 0 && reports.every((report) => report.verified),
        reports,
      };
    }

Create packages/core/src/canonical-json.ts:

    function canonicalValue(value: unknown): unknown {
      if (Array.isArray(value)) {
        return value.map(canonicalValue);
      }
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, canonicalValue(entryValue)]),
        );
      }
      return value;
    }

    export function stringifyCanonical(value: unknown): string {
      return JSON.stringify(canonicalValue(value), null, 2) + '\n';
    }

Create packages/core/src/cli.ts:

    #!/usr/bin/env node
    import { resolve } from 'node:path';
    import { stringifyCanonical } from './canonical-json.js';
    import { evaluateFixture } from './conformance.js';
    import { loadPaymentFixture } from './fixtures/load-fixture.js';

    async function main(args: readonly string[]): Promise<number> {
      const [fixtureArgument, unexpectedArgument] = args;
      if (fixtureArgument === undefined || unexpectedArgument !== undefined) {
        process.stderr.write(
          'Usage: payops-conformance <payment-fixture.json>\n',
        );
        return 2;
      }

      try {
        const fixture = await loadPaymentFixture(resolve(fixtureArgument));
        const report = evaluateFixture(fixture);
        process.stdout.write(stringifyCanonical(report));
        return report.passed ? 0 : 1;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown conformance error';
        process.stderr.write('Conformance error: ' + message + '\n');
        return 2;
      }
    }

    process.exitCode = await main(process.argv.slice(2));

Append to packages/core/src/index.ts:

    export {
      evaluateFixture,
      type ConformanceReport,
    } from './conformance.js';
    export { stringifyCanonical } from './canonical-json.js';

Modify packages/core/package.json to add bin and conformance script:

    {
      "name": "@payops/core",
      "version": "0.0.1",
      "description": "Deterministic Solana payment parsing and verification primitives",
      "type": "module",
      "license": "Apache-2.0",
      "bin": {
        "payops-conformance": "./dist/cli.js"
      },
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        }
      },
      "files": ["dist"],
      "scripts": {
        "build": "tsc -p tsconfig.build.json",
        "conformance": "tsx src/cli.ts",
        "test": "vitest run",
        "typecheck": "tsc -p tsconfig.json"
      },
      "dependencies": {
        "@solana/kit": "7.0.0",
        "bs58": "6.0.0",
        "zod": "4.4.3"
      },
      "devDependencies": {
        "tsx": "4.23.9",
        "vitest": "4.1.10"
      }
    }

Replace the root package.json scripts object with:

    "scripts": {
      "build": "pnpm -r build",
      "check": "pnpm format:check && pnpm typecheck && pnpm test",
      "conformance": "pnpm --filter @payops/core conformance",
      "format": "prettier --write .",
      "format:check": "prettier --check .",
      "test": "pnpm -r test",
      "typecheck": "pnpm -r typecheck"
    }

- [ ] **Step 4: Add public documentation and continuous integration**

Create README.md:

    # Solana Payment Operations

    Solana Payment Operations is an Apache-2.0 payment-integrity and
    reconciliation project. PayOps Core turns raw Solana transaction data into
    deterministic, inspectable payment verification reports.

    ## Current vertical slice

    The first release:

    - validates an exact mainnet asset allowlist;
    - loads a versioned payment conformance fixture;
    - resolves static and address-table account metadata;
    - decodes legacy SPL Token TransferChecked amounts as bigint;
    - parses outer and inner instruction coordinates;
    - verifies cluster, finality, token program, mint, destination owner,
      amount, decimals, reference, self-transfer safety, and aggregate balance
      conservation;
    - emits canonical JSON suitable for CI and fixture conformance.

    It does not sign transactions, hold keys, send funds, call RPC providers,
    or make compliance claims.

    ## Requirements

    - Node.js 22.18 or newer
    - pnpm 11.15.0

    ## Run

        pnpm install
        pnpm check
        pnpm --filter @payops/core conformance \
          ../../fixtures/v0.1/usdc-transfer-checked-finalized.json

    A passing fixture exits with status 0. A parsed payment that fails a
    verification rule exits with status 1. Invalid CLI usage or an invalid
    fixture exits with status 2.

    ## Design

    The complete product and technical design is in
    docs/superpowers/specs/2026-08-06-solana-payment-ops-design.md.

    ## License

    Apache-2.0.

Create .github/workflows/ci.yml:

    name: ci

    on:
      pull_request:
      push:
        branches:
          - main
          - "codex/**"

    permissions:
      contents: read

    jobs:
      verify:
        runs-on: ubuntu-latest
        timeout-minutes: 10
        steps:
          - uses: actions/checkout@v4
          - uses: pnpm/action-setup@v4
            with:
              version: 11.15.0
          - uses: actions/setup-node@v4
            with:
              node-version: 22.18.0
              cache: pnpm
          - run: pnpm install --frozen-lockfile
          - run: pnpm check
          - run: pnpm build
          - run: >-
              pnpm --filter @payops/core conformance
              ../../fixtures/v0.1/usdc-transfer-checked-finalized.json

- [ ] **Step 5: Verify the complete public vertical slice**

Run:

    pnpm format
    pnpm check
    pnpm build
    pnpm --filter @payops/core conformance ../../fixtures/v0.1/usdc-transfer-checked-finalized.json
    git diff --check

Expected:

- Formatting succeeds.
- Ten tests pass.
- TypeScript reports no errors.
- Build emits packages/core/dist/cli.js and packages/core/dist/index.js.
- Conformance output contains passed: true and exits with status 0.
- git diff --check reports no whitespace errors.

- [ ] **Step 6: Commit the conformance release**

Run:

    git add .github README.md package.json packages/core
    git commit -m "feat: ship PayOps conformance CLI"

Expected: a focused commit that makes the first open-core vertical slice runnable locally and in GitHub Actions.

---

## Plan self-review record

### Spec coverage in this slice

- Exact canonical USDC and USDT allowlist: Task 1.
- Raw RPC fixture and deterministic schema: Task 2.
- Versioned account-key resolution foundation: Task 3.
- Integer TransferChecked decoding: Task 3.
- Outer and inner instruction identity: Task 4.
- Reference parsing as correlation metadata: Task 4.
- Exact token, destination, owner, amount, decimals, commitment, and reference verification: Task 5.
- Transaction-level balance-delta reconciliation against aggregate parsed events: Task 5.
- Self-transfer rejection: Task 5.
- Reproducible open conformance output and CI: Task 6.

### Requirements intentionally assigned to later plans

- Live RPC ingestion, pagination watermarks, finality revisits, provider disagreement, and raw archive.
- Merchant wallet proof, ATA derivation, organizations, users, customers, and invoices.
- Fiat and stablecoin quote adapters, depeg policies, checkout, and expiry cutoff slots.
- Allocation, exceptions, opening balances, double-entry ledger, and accounting exports.
- Webhook delivery, signed evidence manifests, refunds, dashboard, and production security.

### Type consistency check

- PaymentFixture is defined once from PaymentFixtureSchema and consumed by every later task.
- ParsedTransfer stores token amounts as decimal integer strings and instruction coordinates as numbers.
- decodeTransferChecked is the only binary amount decoder and returns bigint.
- verifyPayment receives the selected transfer plus every parsed transfer so account-level deltas can be checked against aggregate instruction effects.
- ConformanceReport contains only JSON-serializable types.
