import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateFixture,
  loadPaymentFixture,
  stringifyCanonical,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);

describe("conformance report", () => {
  it("produces stable passing JSON for the canonical fixture", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const report = evaluateFixture(fixture);
    const first = stringifyCanonical(report);
    const second = stringifyCanonical(report);

    expect(report.passed).toBe(true);
    expect(report.reports).toHaveLength(1);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(first).toContain('"passed": true');
  });

  it("sorts keys by locale-independent Unicode code units", () => {
    expect(stringifyCanonical({ z: 2, A: 4, _: 3, ä: 1 })).toBe(
      '{\n  "A": 4,\n  "_": 3,\n  "z": 2,\n  "ä": 1\n}\n',
    );
  });

  it("passes one exact payment while reporting unrelated transfers", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    fixture.rpcTransaction.transaction.message.instructions.push({
      programIdIndex: 4,
      accounts: [2, 3, 1, 0, 5],
      data: "gvPShZQhKrzGM",
    });
    const sourceBalance = fixture.rpcTransaction.meta.postTokenBalances.find(
      (balance) => balance.accountIndex === 1,
    );
    const destinationBalance =
      fixture.rpcTransaction.meta.postTokenBalances.find(
        (balance) => balance.accountIndex === 2,
      );
    if (sourceBalance === undefined || destinationBalance === undefined) {
      throw new Error("Expected canonical token balances");
    }
    sourceBalance.uiTokenAmount.amount = "8500000";
    destinationBalance.uiTokenAmount.amount = "11500000";

    const report = evaluateFixture(fixture);

    expect(report.reports).toHaveLength(2);
    expect(
      report.reports.filter((candidate) => candidate.verified),
    ).toHaveLength(1);
    expect(report.passed).toBe(true);
  });

  it("fails closed when more than one event matches the payment", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const transferInstruction =
      fixture.rpcTransaction.transaction.message.instructions[0];
    const sourcePreBalance = fixture.rpcTransaction.meta.preTokenBalances.find(
      (balance) => balance.accountIndex === 1,
    );
    const sourcePostBalance =
      fixture.rpcTransaction.meta.postTokenBalances.find(
        (balance) => balance.accountIndex === 1,
      );
    const destinationPostBalance =
      fixture.rpcTransaction.meta.postTokenBalances.find(
        (balance) => balance.accountIndex === 2,
      );
    if (
      transferInstruction === undefined ||
      sourcePreBalance === undefined ||
      sourcePostBalance === undefined ||
      destinationPostBalance === undefined
    ) {
      throw new Error("Expected canonical instruction and balances");
    }
    fixture.rpcTransaction.transaction.message.instructions.push(
      structuredClone(transferInstruction),
    );
    sourcePreBalance.uiTokenAmount.amount = "30000000";
    sourcePostBalance.uiTokenAmount.amount = "5000000";
    destinationPostBalance.uiTokenAmount.amount = "25000000";

    const report = evaluateFixture(fixture);

    expect(
      report.reports.filter((candidate) => candidate.verified),
    ).toHaveLength(2);
    expect(report.passed).toBe(false);
  });
});
