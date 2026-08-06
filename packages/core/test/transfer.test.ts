import { describe, expect, it } from "vitest";
import { decodeTransfer } from "../src/index.js";

describe("decodeTransfer", () => {
  it("decodes the legacy SPL Token amount", () => {
    expect(decodeTransfer("3Jw9y63HdCBH")).toEqual({
      amountBaseUnits: 12_500_000n,
    });
  });

  it("rejects another instruction discriminator", () => {
    expect(() => decodeTransfer("gX7kDtBjAyK57")).toThrow(
      "Expected SPL Token Transfer instruction",
    );
  });
});
