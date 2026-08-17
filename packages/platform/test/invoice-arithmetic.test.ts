import { describe, expect, it } from "vitest";
import { calculateInvoiceTotals } from "../src/index.js";

describe("invoice arithmetic", () => {
  it("uses exact rational arithmetic and rounds each line up", () => {
    expect(
      calculateInvoiceTotals([
        {
          description: "Fractional service",
          quantity: "1.5",
          unitPriceMinorUnits: "101",
          taxLabel: "GST",
          taxMinorUnits: "18",
        },
        {
          description: "Small fraction",
          quantity: "0.000001",
          unitPriceMinorUnits: "1",
          taxMinorUnits: "0",
        },
      ]),
    ).toMatchObject({
      lines: [
        { lineSubtotalMinorUnits: "152" },
        { lineSubtotalMinorUnits: "1" },
      ],
      subtotalMinorUnits: "153",
      taxMinorUnits: "18",
      totalMinorUnits: "171",
    });
  });

  it("rejects noncanonical, unbounded, zero, and overflowing amounts", () => {
    const valid = {
      description: "Line",
      quantity: "1",
      unitPriceMinorUnits: "1",
      taxMinorUnits: "0",
    };
    for (const line of [
      { ...valid, quantity: "0" },
      { ...valid, quantity: "01" },
      { ...valid, quantity: "1.0000000" },
      { ...valid, quantity: "-1" },
      { ...valid, unitPriceMinorUnits: "01" },
      { ...valid, unitPriceMinorUnits: "9".repeat(39) },
      {
        ...valid,
        quantity: "9".repeat(38),
        unitPriceMinorUnits: "9".repeat(38),
      },
      { ...valid, description: "😀".repeat(513) },
    ]) {
      expect(() => calculateInvoiceTotals([line])).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/^(?:invalid_invoice|invoice_amount)/),
        }),
      );
    }
    expect(() =>
      calculateInvoiceTotals(Array.from({ length: 101 }, () => valid)),
    ).toThrowError(expect.objectContaining({ code: "invalid_invoice_lines" }));
  });
});
