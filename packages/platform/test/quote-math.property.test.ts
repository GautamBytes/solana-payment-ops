import { describe, expect, it } from "vitest";
import {
  calculateQuote,
  QuoteMathError,
  reproduceQuote,
  type QuoteCalculationInput,
} from "../src/index.js";

describe("exact quote math", () => {
  it.each([
    ["USD", undefined, "1", "1", "1000000", "1"],
    [
      "EUR",
      { USD: "1.1", GBP: "0.85", INR: "95" },
      "1.1",
      "1.1",
      "1100000",
      "1.1",
    ],
    [
      "GBP",
      { USD: "1.1", GBP: "0.85", INR: "95" },
      "1.2941176470588235294117647058823529411764705882352941176470588235",
      "1.2941176470588235294117647058823529411764705882352941176470588235",
      "1294118",
      "1.294118",
    ],
    [
      "INR",
      { USD: "1.1", GBP: "0.85", INR: "95" },
      "0.011578947368421052631578947368421052631578947368421052631578947368",
      "0.011578947368421052631578947368421052631578947368421052631578947368",
      "11579",
      "0.011579",
    ],
  ] as const)(
    "calculates %s without under-collecting",
    (currency, fiatRates, usdAmount, tokenAmount, baseUnits, amountTokens) => {
      const input: QuoteCalculationInput = {
        invoiceCurrency: currency,
        invoiceMinorUnits: "100",
        stablecoinUsdPrice: "1",
        ...(fiatRates === undefined ? {} : { fiatRates }),
      };
      const result = calculateQuote(input);
      expect(result.usdAmount).toBe(usdAmount);
      expect(result.tokenAmount).toBe(tokenAmount);
      expect(result.amountBaseUnits).toBe(baseUnits);
      expect(result.amountTokens).toBe(amountTokens);
      expect(reproduceQuote(input, result.inputDigest)).toEqual(result);
    },
  );

  it.each<readonly [string, Partial<QuoteCalculationInput>]>([
    ["zero invoice", { invoiceMinorUnits: "0" }],
    ["negative invoice", { invoiceMinorUnits: "-1" }],
    ["exponent rate", { stablecoinUsdPrice: "1e0" }],
    ["whitespace", { stablecoinUsdPrice: " 1" }],
    ["leading plus", { stablecoinUsdPrice: "+1" }],
    ["missing FX", { invoiceCurrency: "GBP" }],
    [
      "u64 overflow",
      {
        invoiceMinorUnits: "1844674407370955161500",
        stablecoinUsdPrice: "0.000001",
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(() =>
      calculateQuote({
        invoiceCurrency: "USD",
        invoiceMinorUnits: "100",
        stablecoinUsdPrice: "1",
        ...overrides,
      }),
    ).toThrowError(QuoteMathError);
  });

  it("proves rounded base units cover exact USD value for 10,000 deterministic cases", () => {
    let seed = 0x8badf00d;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    for (let index = 0; index < 10_000; index += 1) {
      const invoiceMinorUnits = String((random() % 10_000_000_000) + 1);
      const priceMillionths = BigInt((random() % 20_001) + 990_000);
      const stablecoinUsdPrice = decimalMillionths(priceMillionths);
      const quote = calculateQuote({
        invoiceCurrency: "USD",
        invoiceMinorUnits,
        stablecoinUsdPrice,
      });
      const collectedNumerator =
        BigInt(quote.amountBaseUnits) * priceMillionths;
      const owedNumerator = BigInt(invoiceMinorUnits) * 10n ** 10n;
      expect(collectedNumerator).toBeGreaterThanOrEqual(owedNumerator);
    }
  });

  it("is locale-independent and rejects a changed reproduction digest", () => {
    const originalLocale = Intl.NumberFormat().resolvedOptions().locale;
    const input: QuoteCalculationInput = {
      invoiceCurrency: "USD",
      invoiceMinorUnits: "123456",
      stablecoinUsdPrice: "1.0001",
    };
    const quote = calculateQuote(input);
    expect(Intl.NumberFormat().resolvedOptions().locale).toBe(originalLocale);
    expect(() => reproduceQuote(input, "0".repeat(64))).toThrowError(
      expect.objectContaining({ code: "quote_digest_mismatch" }),
    );
  });
});

function decimalMillionths(value: bigint): string {
  const digits = value.toString().padStart(7, "0");
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(/0+$/, "");
}
