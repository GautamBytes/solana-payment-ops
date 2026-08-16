import { describe, expect, it } from "vitest";
import { sampleWorkspace } from "../lib/try/sample-workspace";

describe("Try PayOps sample workspace", () => {
  it("is deterministic, synthetic, and covers matched plus exception decisions", () => {
    expect(sampleWorkspace.kind).toBe("sample");
    expect(sampleWorkspace.disclosure).toContain("synthetic");
    expect(sampleWorkspace.decisions.map(({ state }) => state)).toEqual([
      "matched",
      "exception",
      "exception",
    ]);
    expect(sampleWorkspace.summary).toEqual({
      invoices: 3,
      matchedPayments: 1,
      exceptions: 2,
      finalizedVolume: "37.499999 USDC",
    });
    expect(
      sampleWorkspace.decisions.every(
        ({ signature, evidence }) =>
          /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) &&
          evidence.map(({ stage }) => stage).join(",") ===
            "detect,verify,match,prove",
      ),
    ).toBe(true);
  });

  it("links each scenario to a bundled v0.1 fixture and exposes no mutation", () => {
    expect(
      sampleWorkspace.decisions.map(({ sourceFixture }) => sourceFixture),
    ).toEqual([
      "fixtures/v0.1/usdc-transfer-checked-finalized.json",
      "fixtures/v0.1/cases/wrong-destination-token-account.json",
      "fixtures/v0.1/cases/partial-base-unit-amount.json",
    ]);
    expect(JSON.stringify(sampleWorkspace)).not.toMatch(
      /assign|resolve|promote|private.?key|seed.?phrase/i,
    );
  });
});
