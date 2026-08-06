import { describe, expect, it } from "vitest";
import { decodeTransferChecked } from "../src/index.js";

describe("decodeTransferChecked", () => {
  it("decodes u64 amount and decimals without floating point", () => {
    expect(decodeTransferChecked("gX7kDtBjAyK57")).toEqual({
      amountBaseUnits: 12500000n,
      decimals: 6,
    });
  });

  it("rejects non-TransferChecked data", () => {
    expect(() => decodeTransferChecked("2")).toThrow(
      "Unsupported token instruction discriminator",
    );
  });
});
