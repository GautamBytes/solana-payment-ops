import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPaymentFixture,
  parseTransferCheckedEvents,
  type ParsedTransfer,
  type PaymentFixture,
  type VerificationCode,
  verifyPayment,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);

function findDestinationBalance(fixture: PaymentFixture) {
  const balance = fixture.rpcTransaction.meta.postTokenBalances.find(
    (candidate) => candidate.accountIndex === 2,
  );
  if (balance === undefined) {
    throw new Error("Expected destination balance");
  }
  return balance;
}

interface VerificationMutation {
  readonly code: VerificationCode;
  readonly mutate: (
    fixture: PaymentFixture,
    transfer: ParsedTransfer,
  ) => ParsedTransfer;
}

const failClosedMutations: readonly VerificationMutation[] = [
  {
    code: "transaction_success",
    mutate: (fixture, transfer) => {
      Reflect.set(fixture.rpcTransaction.meta, "err", "AccountInUse");
      return transfer;
    },
  },
  {
    code: "cluster",
    mutate: (fixture, transfer) => {
      Reflect.set(fixture.rpcTransaction, "cluster", "devnet");
      return transfer;
    },
  },
  {
    code: "commitment",
    mutate: (fixture, transfer) => {
      fixture.rpcTransaction.commitment = "confirmed";
      return transfer;
    },
  },
  {
    code: "token_program",
    mutate: (_fixture, transfer) => ({
      ...transfer,
      programId: "11111111111111111111111111111111",
    }),
  },
  {
    code: "mint",
    mutate: (_fixture, transfer) => ({
      ...transfer,
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    }),
  },
  {
    code: "destination",
    mutate: (_fixture, transfer) => ({
      ...transfer,
      destinationTokenAccount: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
    }),
  },
  {
    code: "destination_owner",
    mutate: (fixture, transfer) => {
      findDestinationBalance(fixture).owner =
        "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw";
      return transfer;
    },
  },
  {
    code: "destination_token_program",
    mutate: (fixture, transfer) => {
      findDestinationBalance(fixture).programId =
        "11111111111111111111111111111111";
      return transfer;
    },
  },
  {
    code: "destination_balance_mint",
    mutate: (fixture, transfer) => {
      findDestinationBalance(fixture).mint =
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
      return transfer;
    },
  },
  {
    code: "amount",
    mutate: (_fixture, transfer) => ({
      ...transfer,
      amountBaseUnits: "12499999",
    }),
  },
  {
    code: "decimals",
    mutate: (_fixture, transfer) => ({ ...transfer, decimals: 5 }),
  },
  {
    code: "reference",
    mutate: (_fixture, transfer) => ({ ...transfer, references: [] }),
  },
  {
    code: "unambiguous_reference_accounts",
    mutate: (_fixture, transfer) => ({
      ...transfer,
      unsupportedExtraAccounts: ["4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw"],
    }),
  },
  {
    code: "non_self_transfer",
    mutate: (_fixture, transfer) => ({
      ...transfer,
      sourceAccountIndex: transfer.destinationAccountIndex,
      sourceTokenAccount: transfer.destinationTokenAccount,
    }),
  },
  {
    code: "destination_balance_delta",
    mutate: (fixture, transfer) => {
      findDestinationBalance(fixture).uiTokenAmount.amount = "12499999";
      return transfer;
    },
  },
];

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

  it("reconciles an exact payment against the aggregate transaction delta", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const transfers = parseTransferCheckedEvents(fixture);
    const transfer = transfers[0];
    const destinationBalance =
      fixture.rpcTransaction.meta.postTokenBalances.find(
        (balance) => balance.accountIndex === 2,
      );
    if (transfer === undefined || destinationBalance === undefined) {
      throw new Error("Expected transfer and destination balance");
    }
    destinationBalance.uiTokenAmount.amount = "11500000";
    const outgoingTransfer = {
      ...transfer,
      eventId: `${transfer.eventId}:outgoing`,
      sourceTokenAccount: transfer.destinationTokenAccount,
      sourceAccountIndex: transfer.destinationAccountIndex,
      destinationTokenAccount: transfer.sourceTokenAccount,
      destinationAccountIndex: transfer.sourceAccountIndex,
      amountBaseUnits: "1000000",
      references: [],
    };

    const report = verifyPayment(fixture, transfer, [
      transfer,
      outgoingTransfer,
    ]);
    const balanceCheck = report.checks.find(
      (check) => check.code === "destination_balance_delta",
    );

    expect(report.verified).toBe(true);
    expect(balanceCheck?.passed).toBe(true);
    expect(balanceCheck).toMatchObject({
      expected: "11500000",
      actual: "11500000",
    });
  });

  it.each(failClosedMutations)(
    "fails closed for the $code rule",
    async ({ code, mutate }) => {
      const fixture = await loadPaymentFixture(fixturePath);
      const parsed = parseTransferCheckedEvents(fixture)[0];
      if (parsed === undefined) {
        throw new Error("Expected one parsed transfer");
      }
      const transfer = mutate(fixture, parsed);
      const report = verifyPayment(fixture, transfer, [transfer]);
      const check = report.checks.find((candidate) => candidate.code === code);

      expect(report.verified).toBe(false);
      expect(check?.passed).toBe(false);
    },
  );
});
