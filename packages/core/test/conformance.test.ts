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
});
