import { address } from "@solana/kit";
import { MAINNET_USDC, MAINNET_USDT } from "@payops/core";
import { parse } from "csv-parse/sync";
import type { InvoiceImport } from "../domain/types.js";
import { ReconciliationError } from "../domain/types.js";

const EXPECTED_HEADER = [
  "invoice_id",
  "customer_id",
  "expected_mint",
  "destination_token_account",
  "amount_base_units",
  "reference_address",
  "issued_at",
  "due_at",
] as const;

const SUPPORTED_MINTS = new Set<string>([MAINNET_USDC.mint, MAINNET_USDT.mint]);

function invalid(message: string, cause?: unknown): ReconciliationError {
  return new ReconciliationError("invalid_invoice_csv", message, {
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function required(
  value: string | undefined,
  field: string,
  row: number,
): string {
  if (value === undefined || value.length === 0) {
    throw invalid(`Row ${row} requires ${field}`);
  }
  return value;
}

function solanaAddress(value: string, field: string, row: number): string {
  try {
    return address(value);
  } catch (error) {
    throw invalid(`Row ${row} has an invalid ${field}`, error);
  }
}

function timestamp(value: string, field: string, row: number): Date {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw invalid(`Row ${row} has an invalid ${field}`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(`Row ${row} has an invalid ${field}`);
  }
  return parsed;
}

function parseRow(values: readonly string[], row: number): InvoiceImport {
  if (values.length !== EXPECTED_HEADER.length) {
    throw invalid(`Row ${row} must contain ${EXPECTED_HEADER.length} columns`);
  }
  const invoiceId = required(values[0], "invoice_id", row);
  const customerId = required(values[1], "customer_id", row);
  const expectedMint = solanaAddress(
    required(values[2], "expected_mint", row),
    "expected_mint",
    row,
  );
  if (!SUPPORTED_MINTS.has(expectedMint)) {
    throw invalid(`Row ${row} uses an unsupported expected_mint`);
  }
  const destinationTokenAccount = solanaAddress(
    required(values[3], "destination_token_account", row),
    "destination_token_account",
    row,
  );
  const amount = required(values[4], "amount_base_units", row);
  if (!/^[1-9][0-9]{0,77}$/.test(amount)) {
    throw invalid(`Row ${row} amount_base_units must be a positive integer`);
  }
  const referenceAddress = solanaAddress(
    required(values[5], "reference_address", row),
    "reference_address",
    row,
  );
  const issuedAt = timestamp(
    required(values[6], "issued_at", row),
    "issued_at",
    row,
  );
  const dueAt = timestamp(required(values[7], "due_at", row), "due_at", row);
  if (dueAt.getTime() <= issuedAt.getTime()) {
    throw invalid(`Row ${row} due_at must be later than issued_at`);
  }
  return {
    invoiceId,
    customerId,
    expectedMint,
    destinationTokenAccount,
    amountBaseUnits: BigInt(amount),
    referenceAddress,
    issuedAt,
    dueAt,
  };
}

export function parseInvoiceCsv(input: string): readonly InvoiceImport[] {
  let records: string[][];
  try {
    records = parse(input, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
    }) as string[][];
  } catch (error) {
    throw invalid("Invoice CSV could not be parsed", error);
  }
  const [header, ...rows] = records;
  if (
    header === undefined ||
    header.length !== EXPECTED_HEADER.length ||
    !header.every((value, index) => value === EXPECTED_HEADER[index])
  ) {
    throw invalid(`Invoice CSV header must be ${EXPECTED_HEADER.join(",")}`);
  }
  const invoices = rows.map((values, index) => parseRow(values, index + 2));
  const invoiceIds = new Set<string>();
  const references = new Set<string>();
  for (const invoice of invoices) {
    if (invoiceIds.has(invoice.invoiceId)) {
      throw invalid(`Invoice ID ${invoice.invoiceId} appears more than once`);
    }
    if (references.has(invoice.referenceAddress)) {
      throw invalid(
        `Reference address ${invoice.referenceAddress} appears more than once`,
      );
    }
    invoiceIds.add(invoice.invoiceId);
    references.add(invoice.referenceAddress);
  }
  return invoices;
}
