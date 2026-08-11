import type { AuditReportV01 } from "../domain/types.js";

const columns = [
  "invoice_id",
  "customer_id",
  "status",
  "expected_mint",
  "amount_base_units",
  "event_id",
  "rule_code",
] as const;

export function renderAuditCsv(report: AuditReportV01): string {
  const lines = [columns.join(",")];
  for (const row of report.rows) {
    lines.push(
      [
        row.invoiceId ?? "",
        row.customerId ?? "",
        row.status,
        row.expectedMint,
        row.amountBaseUnits,
        row.eventId ?? "",
        row.ruleCode ?? "",
      ]
        .map(quoteCsv)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function quoteCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
