import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateManifest, FixtureManifestSchema } from "../src/index.js";

const manifestPath = fileURLToPath(
  new URL("../../../fixtures/v0.1/manifest.json", import.meta.url),
);

const caseIds = [
  "usdc-transfer-checked-v0-finalized",
  "usdt-transfer-checked-legacy-finalized",
  "usdc-transfer-balance-proven-legacy",
  "usdc-transfer-checked-inner-cpi",
  "usdt-transfer-inner-cpi",
  "versioned-address-lookup-table",
  "two-distinct-transfer-instructions",
  "two-credits-same-destination-balanced",
  "multiple-readonly-references",
  "missing-reference",
  "unknown-reference",
  "ambiguous-reference-expectations",
  "lookalike-wrong-mint",
  "unsupported-token-2022-program",
  "wrong-destination-token-account",
  "destination-owner-mismatch",
  "partial-base-unit-amount",
  "excess-base-unit-amount",
  "failed-transaction",
  "null-block-time",
  "confirmed-provisional-payment",
  "confirmed-then-reverted-scenario",
  "duplicate-looking-distinct-instruction",
  "truncated-rpc-envelope-rejection",
  "unicode-identifier-boundaries",
] as const;

describe("v0.1 payment conformance corpus", () => {
  it("contains the exact 25 synthetic cases in stable order", async () => {
    const manifest = FixtureManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );

    expect(manifest.cases.map(({ id }) => id)).toEqual(caseIds);
    expect(
      manifest.cases.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256)),
    ).toBe(true);
  });

  it("matches every exact expectation and produces a repeatable digest", async () => {
    const first = await evaluateManifest(manifestPath);
    const second = await evaluateManifest(manifestPath);

    expect(first).toEqual(second);
    expect(first.passed).toBe(true);
    expect(first.cases).toHaveLength(25);
    expect(first.cases.every(({ passed }) => passed)).toBe(true);
  });

  it("models confirmation followed by reversion without a paid allocation", async () => {
    const raw = await readFile(
      new URL(
        "../../../fixtures/v0.1/cases/confirmed-then-reverted-scenario.json",
        import.meta.url,
      ),
      "utf8",
    );
    const scenario = JSON.parse(raw) as {
      rpcTransaction: {
        observations: unknown[];
        expectedPaidAllocations: number;
      };
    };

    expect(scenario.rpcTransaction.observations).toEqual([
      {
        commitment: "confirmed",
        transactionError: null,
        paymentState: "provisional",
      },
      {
        commitment: "finalized",
        transactionError: "TransactionReverted",
        paymentState: "reverted",
      },
    ]);
    expect(scenario.rpcTransaction.expectedPaidAllocations).toBe(0);
  });
});
