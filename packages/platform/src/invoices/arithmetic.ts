import { InvoiceError, type InvoiceLineInput } from "./types.js";

const integerPattern = /^(0|[1-9][0-9]{0,37})$/;
const quantityPattern = /^(0|[1-9][0-9]{0,37})(?:\.([0-9]{1,6}))?$/;
const maximum = 10n ** 38n - 1n;

export interface CalculatedInvoiceLine extends InvoiceLineInput {
  readonly taxLabel: string | null;
  readonly lineSubtotalMinorUnits: string;
}

export interface InvoiceTotals {
  readonly lines: readonly CalculatedInvoiceLine[];
  readonly subtotalMinorUnits: string;
  readonly taxMinorUnits: string;
  readonly totalMinorUnits: string;
}

export function calculateInvoiceTotals(
  input: readonly InvoiceLineInput[],
): InvoiceTotals {
  if (input.length < 1 || input.length > 100)
    throw new InvoiceError("invalid_invoice_lines");
  let subtotal = 0n;
  let tax = 0n;
  const lines = input.map((line) => {
    const description = line.description.trim().normalize("NFC");
    if ([...description].length < 1 || [...description].length > 512) {
      throw new InvoiceError("invalid_invoice_line_description");
    }
    const quantity = parseQuantity(line.quantity);
    const unitPrice = parseAmount(line.unitPriceMinorUnits);
    const lineTax = parseAmount(line.taxMinorUnits);
    const numerator = checkedMultiply(quantity.numerator, unitPrice);
    const lineSubtotal = checkedAmount(
      (numerator + quantity.denominator - 1n) / quantity.denominator,
    );
    subtotal = checkedAmount(subtotal + lineSubtotal);
    tax = checkedAmount(tax + lineTax);
    const taxLabel = normalizeTaxLabel(line.taxLabel);
    return {
      description,
      quantity: quantity.canonical,
      unitPriceMinorUnits: unitPrice.toString(),
      taxLabel,
      taxMinorUnits: lineTax.toString(),
      lineSubtotalMinorUnits: lineSubtotal.toString(),
    };
  });
  const total = checkedAmount(subtotal + tax);
  return {
    lines,
    subtotalMinorUnits: subtotal.toString(),
    taxMinorUnits: tax.toString(),
    totalMinorUnits: total.toString(),
  };
}

export function assertExpectedTotals(
  actual: InvoiceTotals,
  expected: {
    readonly subtotalMinorUnits?: string;
    readonly taxMinorUnits?: string;
    readonly totalMinorUnits?: string;
  },
): void {
  for (const key of [
    "subtotalMinorUnits",
    "taxMinorUnits",
    "totalMinorUnits",
  ] as const) {
    if (expected[key] !== undefined && expected[key] !== actual[key]) {
      throw new InvoiceError("invoice_total_mismatch");
    }
  }
}

function parseAmount(value: string): bigint {
  if (!integerPattern.test(value))
    throw new InvoiceError("invalid_invoice_amount");
  return checkedAmount(BigInt(value));
}

function parseQuantity(value: string): {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly canonical: string;
} {
  const match = quantityPattern.exec(value);
  if (match === null) throw new InvoiceError("invalid_invoice_quantity");
  const fraction = match[2] ?? "";
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${value.split(".")[0]}${fraction}`);
  if (numerator <= 0n) throw new InvoiceError("invalid_invoice_quantity");
  return { numerator, denominator, canonical: value };
}

function normalizeTaxLabel(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().normalize("NFC");
  if ([...normalized].length < 1 || [...normalized].length > 128) {
    throw new InvoiceError("invalid_invoice_tax_label");
  }
  return normalized;
}

function checkedMultiply(left: bigint, right: bigint): bigint {
  if (left !== 0n && right > maximum / left)
    throw new InvoiceError("invoice_amount_overflow");
  return left * right;
}

function checkedAmount(value: bigint): bigint {
  if (value < 0n || value > maximum)
    throw new InvoiceError("invoice_amount_overflow");
  return value;
}
