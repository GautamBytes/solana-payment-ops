import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPaymentFixture, PaymentFixtureSchema } from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);

describe("PaymentFixtureSchema", () => {
  it("loads the canonical USDC fixture without losing integer strings", async () => {
    const fixture = await loadPaymentFixture(fixturePath);

    expect(fixture.fixtureVersion).toBe("0.1");
    expect(fixture.expectation.amountBaseUnits).toBe("12500000");
    expect(
      fixture.rpcTransaction.meta.postTokenBalances[1]?.uiTokenAmount.amount,
    ).toBe("12500000");
    expect(fixture.rpcTransaction.version).toBe(0);
    expect(fixture.rpcTransaction.transaction.signatures[0]).toBe(
      fixture.rpcTransaction.signature,
    );
    expect(
      fixture.rpcTransaction.transaction.message.addressTableLookups,
    ).toHaveLength(1);
    expect(fixture.rpcTransaction.meta.loadedAddresses?.readonly).toEqual([
      fixture.expectation.reference,
    ]);
  });

  it("rejects a malformed Solana reference", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const result = PaymentFixtureSchema.safeParse({
      ...fixture,
      expectation: {
        ...fixture.expectation,
        reference: "not-a-solana-address",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts string-valued Solana transaction errors as failed evidence", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    Reflect.set(fixture.rpcTransaction.meta, "err", "AccountInUse");

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("accepts structured Solana transaction errors as failed evidence", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    fixture.rpcTransaction.meta.err = {
      InstructionError: [0, { Custom: 6001 }],
    };

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects an envelope signature that differs from the transaction", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    fixture.rpcTransaction.signature =
      "1111111111111111111111111111111111111111111111111111111111111111";

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects inner instructions that point beyond the outer instruction list", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const instruction =
      fixture.rpcTransaction.transaction.message.instructions[0];
    if (instruction === undefined) {
      throw new Error("Expected one outer instruction");
    }
    fixture.rpcTransaction.meta.innerInstructions = [
      { index: 10, instructions: [instruction] },
    ];

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects account indexes beyond static and loaded keys", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const instruction =
      fixture.rpcTransaction.transaction.message.instructions[0];
    if (instruction === undefined) {
      throw new Error("Expected one outer instruction");
    }
    instruction.accounts = [...instruction.accounts, 99];

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects loaded-address counts that disagree with table lookups", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const loadedAddresses = fixture.rpcTransaction.meta.loadedAddresses;
    if (loadedAddresses === undefined) {
      throw new Error("Expected loaded addresses");
    }
    loadedAddresses.readonly = [];

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects transaction versions the parser does not support", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    Reflect.set(fixture.rpcTransaction, "version", 99);

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("requires at least one writable signer for the fee payer", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    fixture.rpcTransaction.transaction.message.header.numReadonlySignedAccounts = 1;

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects duplicate CPI parent groups that would collide event IDs", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const instruction =
      fixture.rpcTransaction.transaction.message.instructions[0];
    if (instruction === undefined) {
      throw new Error("Expected one outer instruction");
    }
    fixture.rpcTransaction.meta.innerInstructions = [
      { index: 0, instructions: [instruction] },
      { index: 0, instructions: [instruction] },
    ];

    expect(PaymentFixtureSchema.safeParse(fixture).success).toBe(false);
  });
});
