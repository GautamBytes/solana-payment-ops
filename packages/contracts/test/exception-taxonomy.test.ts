import { describe, expect, it } from "vitest";
import { EXCEPTION_CODES } from "../src/index.js";

describe("exception taxonomy", () => {
  it("publishes the complete v0.1 reconciliation exception vocabulary", () => {
    expect(EXCEPTION_CODES).toEqual([
      "missing_reference",
      "unknown_reference",
      "ambiguous_reference",
      "duplicate_payment",
      "wrong_asset",
      "wrong_destination",
      "missing_block_time",
      "before_issue",
      "late_payment",
      "partial_payment",
      "excess_payment",
    ]);
  });
});
