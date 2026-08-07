import type { InvoiceStatus, ReconciliationRuleCode } from "../domain/types.js";

export interface ReconciliationReportRow {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly status: InvoiceStatus | "unapplied";
  readonly expectedMint: string;
  readonly amountBaseUnits: string;
  readonly eventId: string | null;
  readonly ruleCode: ReconciliationRuleCode | null;
}

const HEADER = [
  "invoice_id",
  "customer_id",
  "status",
  "expected_mint",
  "amount_base_units",
  "event_id",
  "rule_code",
] as const;

function safeCell(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralized)
    ? `"${neutralized.replaceAll('"', '""')}"`
    : neutralized;
}

export function renderCsvReport(
  rows: readonly ReconciliationReportRow[],
): string {
  const body = rows.map((row) =>
    [
      row.invoiceId,
      row.customerId,
      row.status,
      row.expectedMint,
      row.amountBaseUnits,
      row.eventId ?? "",
      row.ruleCode ?? "",
    ]
      .map(safeCell)
      .join(","),
  );
  return `${[HEADER.join(","), ...body].join("\n")}\n`;
}
