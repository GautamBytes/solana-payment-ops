import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPaymentFixture, resolveAccountKeys } from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);

describe("resolveAccountKeys", () => {
  it("derives signer and writable metadata from the message header", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const message = fixture.rpcTransaction.transaction.message;
    const accounts = resolveAccountKeys(
      message,
      fixture.rpcTransaction.meta.loadedAddresses,
    );

    expect(
      accounts.map(({ signer, writable, source }) => ({
        signer,
        writable,
        source,
      })),
    ).toEqual([
      { signer: true, writable: true, source: "static" },
      { signer: false, writable: true, source: "static" },
      { signer: false, writable: true, source: "static" },
      { signer: false, writable: false, source: "static" },
      { signer: false, writable: false, source: "static" },
      { signer: false, writable: false, source: "loaded-readonly" },
    ]);
  });
});
