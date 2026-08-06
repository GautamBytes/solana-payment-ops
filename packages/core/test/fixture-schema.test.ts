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
});
