import { describe, expect, it } from "vitest";
import {
  evaluateQuoteInputs,
  QuotePolicyError,
  type FiatObservation,
  type StablecoinObservation,
} from "../src/index.js";

const now = new Date("2026-08-12T12:00:00.000Z");

describe("quote safety policy", () => {
  it("accepts a fresh, confident, pegged observation", () => {
    expect(
      evaluateQuoteInputs({
        now,
        environment: "production",
        currency: "USD",
        primary: stablecoin(),
      }),
    ).toEqual({ primary: stablecoin(), fiat: null });
  });

  it.each([
    ["rate_stale", stablecoin({ publishTime: "2026-08-12T11:59:29.999Z" })],
    ["rate_invalid", stablecoin({ publishTime: "2026-08-12T12:00:05.001Z" })],
    ["rate_low_confidence", stablecoin({ confidence: "0.00500001" })],
    [
      "stablecoin_depegged",
      stablecoin({ price: "0.989999", confidence: "0.004" }),
    ],
  ] as const)("rejects %s primary input", (code, primary) => {
    expect(() =>
      evaluateQuoteInputs({
        now,
        environment: "production",
        currency: "USD",
        primary,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("requires close secondary input when configured", () => {
    expect(() =>
      evaluateQuoteInputs({
        now,
        environment: "production",
        currency: "USD",
        primary: stablecoin(),
        secondary: stablecoin({
          source: "secondary_commercial",
          price: "0.9949",
          confidence: "0.004",
        }),
        requireSecondary: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<QuotePolicyError>>({
        code: "rate_divergence",
      }),
    );
  });

  it("allows ECB for reference but blocks it for production non-USD quotes", () => {
    const fiat = fiatObservation();
    expect(
      evaluateQuoteInputs({
        now,
        environment: "test",
        currency: "GBP",
        primary: stablecoin(),
        fiat,
      }).fiat,
    ).toEqual(fiat);
    expect(() =>
      evaluateQuoteInputs({
        now,
        environment: "production",
        currency: "GBP",
        primary: stablecoin(),
        fiat,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<QuotePolicyError>>({
        code: "fx_reference_not_production",
      }),
    );
  });

  it("rejects unavailable, malformed, stale, and missing FX inputs generically", () => {
    expect(() =>
      evaluateQuoteInputs({
        now,
        environment: "production",
        currency: "INR",
        primary: stablecoin(),
      }),
    ).toThrowError(expect.objectContaining({ code: "rate_unavailable" }));
    expect(() =>
      evaluateQuoteInputs({
        now,
        environment: "test",
        currency: "EUR",
        primary: stablecoin(),
        fiat: fiatObservation({ receivedAt: "not-a-date" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "rate_invalid" }));
    expect(() =>
      evaluateQuoteInputs({
        now,
        environment: "test",
        currency: "EUR",
        primary: stablecoin(),
        fiat: fiatObservation({ publishedAt: "2026-08-10T23:59:59.999Z" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "rate_stale" }));
  });
});

function stablecoin(
  overrides: Partial<StablecoinObservation> = {},
): StablecoinObservation {
  return {
    source: "pyth_hermes",
    symbol: "USDC",
    price: "1",
    confidence: "0.005",
    exponent: -8,
    publishTime: "2026-08-12T11:59:45.000Z",
    feedId: "a".repeat(64),
    receivedAt: "2026-08-12T12:00:00.000Z",
    rawResponseDigest: "c".repeat(64),
    ...overrides,
  };
}

function fiatObservation(
  overrides: Partial<FiatObservation> = {},
): FiatObservation {
  return {
    source: "ecb_reference",
    base: "EUR",
    rates: { USD: "1.1", GBP: "0.85", INR: "95" },
    observedFor: "2026-08-12",
    publishedAt: "2026-08-12T10:00:00.000Z",
    receivedAt: "2026-08-12T12:00:00.000Z",
    usage: "reference_only",
    rawResponseDigest: "d".repeat(64),
    ...overrides,
  };
}
