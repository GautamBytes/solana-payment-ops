import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPaymentFixture,
  parseTransferCheckedEvents,
  verifyPayment,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);

describe("verifyPayment", () => {
  it("passes every check for the canonical finalized USDC payment", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const transfers = parseTransferCheckedEvents(fixture);
    const transfer = transfers[0];
    if (transfer === undefined) {
      throw new Error("Expected one parsed transfer");
    }

    const report = verifyPayment(fixture, transfer, transfers);

    expect(report.verified).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.checks.map((check) => check.code)).toEqual([
      "transaction_success",
      "cluster",
      "commitment",
      "token_program",
      "mint",
      "destination",
      "destination_owner",
      "destination_token_program",
      "destination_balance_mint",
      "amount",
      "decimals",
      "reference",
      "unambiguous_reference_accounts",
      "non_self_transfer",
      "destination_balance_delta",
    ]);
  });

  it("fails closed when the expected mint differs", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const wrongMintFixture = {
      ...fixture,
      expectation: {
        ...fixture.expectation,
        mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      },
    };
    const transfers = parseTransferCheckedEvents(wrongMintFixture);
    const transfer = transfers[0];
    if (transfer === undefined) {
      throw new Error("Expected one parsed transfer");
    }

    const report = verifyPayment(wrongMintFixture, transfer, transfers);
    const mintCheck = report.checks.find((check) => check.code === "mint");

    expect(report.verified).toBe(false);
    expect(mintCheck?.passed).toBe(false);
  });

  it("does not treat confirmed settlement as final", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const confirmedFixture = structuredClone(fixture);
    confirmedFixture.rpcTransaction.commitment = "confirmed";
    const transfers = parseTransferCheckedEvents(confirmedFixture);
    const transfer = transfers[0];
    if (transfer === undefined) {
      throw new Error("Expected one parsed transfer");
    }

    const report = verifyPayment(confirmedFixture, transfer, transfers);
    const finalityCheck = report.checks.find(
      (check) => check.code === "commitment",
    );

    expect(report.verified).toBe(false);
    expect(finalityCheck).toMatchObject({
      passed: false,
      expected: "finalized",
      actual: "confirmed",
    });
  });

  it("rejects a self-consistent but unsupported token mint", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const unsupportedMint = "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw";
    const unsupportedFixture = structuredClone(fixture);
    unsupportedFixture.expectation.mint = unsupportedMint;
    unsupportedFixture.rpcTransaction.transaction.message.accountKeys[3] =
      unsupportedMint;
    for (const balance of [
      ...unsupportedFixture.rpcTransaction.meta.preTokenBalances,
      ...unsupportedFixture.rpcTransaction.meta.postTokenBalances,
    ]) {
      balance.mint = unsupportedMint;
    }
    const transfers = parseTransferCheckedEvents(unsupportedFixture);
    const transfer = transfers[0];
    if (transfer === undefined) {
      throw new Error("Expected one parsed transfer");
    }

    const report = verifyPayment(unsupportedFixture, transfer, transfers);
    const mintCheck = report.checks.find((check) => check.code === "mint");

    expect(report.verified).toBe(false);
    expect(mintCheck?.passed).toBe(false);
  });

  it("accepts canonical mainnet USDT under the same exact checks", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const usdtMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    const usdtFixture = structuredClone(fixture);
    usdtFixture.expectation.mint = usdtMint;
    usdtFixture.rpcTransaction.transaction.message.accountKeys[3] = usdtMint;
    for (const balance of [
      ...usdtFixture.rpcTransaction.meta.preTokenBalances,
      ...usdtFixture.rpcTransaction.meta.postTokenBalances,
    ]) {
      balance.mint = usdtMint;
    }
    const transfers = parseTransferCheckedEvents(usdtFixture);
    const transfer = transfers[0];
    if (transfer === undefined) {
      throw new Error("Expected one parsed transfer");
    }

    expect(verifyPayment(usdtFixture, transfer, transfers).verified).toBe(true);
  });
});
