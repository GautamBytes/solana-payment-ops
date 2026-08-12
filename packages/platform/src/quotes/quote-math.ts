import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { canonicalJson } from "../idempotency/idempotency-store.js";
import { parseUnsignedDecimal } from "./exact-decimal.js";
import type { QuoteCurrency } from "./types.js";

const QuoteDecimal = Decimal.clone({
  precision: 65,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -1_000_000,
  toExpPos: 1_000_000,
});
const unsignedIntegerPattern = /^(0|[1-9][0-9]{0,37})$/;
const maximumBaseUnits = 18_446_744_073_709_551_615n;

export interface QuoteCalculationInput {
  readonly invoiceCurrency: QuoteCurrency;
  readonly invoiceMinorUnits: string;
  readonly stablecoinUsdPrice: string;
  readonly fiatRates?:
    | Readonly<{
        readonly USD: string;
        readonly GBP: string;
        readonly INR: string;
      }>
    | undefined;
}

export interface QuoteCalculation {
  readonly formulaVersion: "quote-v1";
  readonly invoiceCurrency: QuoteCurrency;
  readonly invoiceMinorUnits: string;
  readonly fiatAmount: string;
  readonly usdAmount: string;
  readonly stablecoinUsdPrice: string;
  readonly tokenAmount: string;
  readonly amountBaseUnits: string;
  readonly amountTokens: string;
  readonly inputDigest: string;
}

export type QuoteMathErrorCode =
  "invalid_quote_input" | "quote_amount_out_of_range" | "quote_digest_mismatch";

export class QuoteMathError extends Error {
  public constructor(readonly code: QuoteMathErrorCode) {
    super("Quote calculation failed");
    this.name = "QuoteMathError";
  }
}

export function calculateQuote(input: QuoteCalculationInput): QuoteCalculation {
  const normalized = normalizeInput(input);
  const invoice = fractionFromInteger(normalized.invoiceMinorUnits, 100n);
  let usd = invoice;
  if (normalized.invoiceCurrency === "EUR") {
    usd = multiply(invoice, fractionFromDecimal(normalized.fiatRates!.USD));
  } else if (normalized.invoiceCurrency === "GBP") {
    usd = divide(
      multiply(invoice, fractionFromDecimal(normalized.fiatRates!.USD)),
      fractionFromDecimal(normalized.fiatRates!.GBP),
    );
  } else if (normalized.invoiceCurrency === "INR") {
    usd = divide(
      multiply(invoice, fractionFromDecimal(normalized.fiatRates!.USD)),
      fractionFromDecimal(normalized.fiatRates!.INR),
    );
  }
  const token = divide(usd, fractionFromDecimal(normalized.stablecoinUsdPrice));
  const amountBaseUnits = ceilFraction(
    multiply(token, { n: 1_000_000n, d: 1n }),
  );
  if (amountBaseUnits < 1n || amountBaseUnits > maximumBaseUnits) {
    throw new QuoteMathError("quote_amount_out_of_range");
  }
  const digestInput = {
    formulaVersion: "quote-v1",
    invoiceCurrency: normalized.invoiceCurrency,
    invoiceMinorUnits: normalized.invoiceMinorUnits,
    stablecoinUsdPrice: normalized.stablecoinUsdPrice,
    fiatRates: normalized.fiatRates,
  } as const;
  return {
    formulaVersion: "quote-v1",
    invoiceCurrency: normalized.invoiceCurrency,
    invoiceMinorUnits: normalized.invoiceMinorUnits,
    fiatAmount: decimalString(invoice),
    usdAmount: decimalString(usd),
    stablecoinUsdPrice: normalized.stablecoinUsdPrice,
    tokenAmount: decimalString(token),
    amountBaseUnits: amountBaseUnits.toString(),
    amountTokens: baseUnitsToTokens(amountBaseUnits),
    inputDigest: createHash("sha256")
      .update(canonicalJson(digestInput), "utf8")
      .digest("hex"),
  };
}

export function reproduceQuote(
  input: QuoteCalculationInput,
  expectedDigest: string,
): QuoteCalculation {
  const quote = calculateQuote(input);
  if (quote.inputDigest !== expectedDigest) {
    throw new QuoteMathError("quote_digest_mismatch");
  }
  return quote;
}

function normalizeInput(input: QuoteCalculationInput): QuoteCalculationInput {
  if (
    !["USD", "EUR", "GBP", "INR"].includes(input.invoiceCurrency) ||
    !unsignedIntegerPattern.test(input.invoiceMinorUnits) ||
    BigInt(input.invoiceMinorUnits) <= 0n
  ) {
    invalid();
  }
  const stablecoinUsdPrice = canonicalPositiveDecimal(input.stablecoinUsdPrice);
  if (input.invoiceCurrency === "USD") {
    if (input.fiatRates !== undefined) invalid();
    return { ...input, stablecoinUsdPrice, fiatRates: undefined };
  }
  const rates = input.fiatRates;
  if (
    rates === undefined ||
    Object.keys(rates).sort().join(",") !== "GBP,INR,USD"
  ) {
    invalid();
  }
  return {
    invoiceCurrency: input.invoiceCurrency,
    invoiceMinorUnits: input.invoiceMinorUnits,
    stablecoinUsdPrice,
    fiatRates: {
      USD: canonicalPositiveDecimal(rates.USD),
      GBP: canonicalPositiveDecimal(rates.GBP),
      INR: canonicalPositiveDecimal(rates.INR),
    },
  };
}

function canonicalPositiveDecimal(value: string): string {
  try {
    const parsed = parseUnsignedDecimal(value, false);
    const canonical =
      parsed.scale === 0
        ? parsed.coefficient.toString()
        : `${parsed.coefficient
            .toString()
            .padStart(parsed.scale + 1, "0")
            .slice(0, -parsed.scale)}.${parsed.coefficient
            .toString()
            .padStart(parsed.scale + 1, "0")
            .slice(-parsed.scale)}`;
    if (canonical !== value) invalid();
    return canonical;
  } catch {
    invalid();
  }
}

interface Fraction {
  readonly n: bigint;
  readonly d: bigint;
}

function fractionFromInteger(value: string, divisor: bigint): Fraction {
  return reduce({ n: BigInt(value), d: divisor });
}

function fractionFromDecimal(value: string): Fraction {
  const parsed = parseUnsignedDecimal(value, false);
  return reduce({ n: parsed.coefficient, d: 10n ** BigInt(parsed.scale) });
}

function multiply(left: Fraction, right: Fraction): Fraction {
  return reduce({ n: left.n * right.n, d: left.d * right.d });
}

function divide(left: Fraction, right: Fraction): Fraction {
  if (right.n === 0n) invalid();
  return reduce({ n: left.n * right.d, d: left.d * right.n });
}

function reduce(value: Fraction): Fraction {
  const divisor = greatestCommonDivisor(value.n, value.d);
  return { n: value.n / divisor, d: value.d / divisor };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function ceilFraction(value: Fraction): bigint {
  return (value.n + value.d - 1n) / value.d;
}

function decimalString(value: Fraction): string {
  return new QuoteDecimal(value.n.toString())
    .div(value.d.toString())
    .toFixed()
    .replace(/\.0+$/, "")
    .replace(/(\.[0-9]*?)0+$/, "$1");
}

function baseUnitsToTokens(value: bigint): string {
  const digits = value.toString().padStart(7, "0");
  const fraction = digits.slice(-6).replace(/0+$/, "");
  return fraction === ""
    ? digits.slice(0, -6)
    : `${digits.slice(0, -6)}.${fraction}`;
}

function invalid(): never {
  throw new QuoteMathError("invalid_quote_input");
}
