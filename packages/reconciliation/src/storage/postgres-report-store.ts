import type { Sql } from "postgres";
import type { InvoiceStatus } from "../domain/types.js";
import type { ReconciliationReportRow } from "../report/csv-report.js";
import type {
  ReconciliationReport,
  ReportDecision,
  ReportInvoice,
} from "../report/json-report.js";

interface ReportInvoiceRow {
  readonly invoice_id: string;
  readonly customer_id: string;
  readonly status: InvoiceStatus;
  readonly expected_mint: string;
  readonly amount_base_units: string;
  readonly reference_address: string;
  readonly issued_at: Date;
  readonly due_at: Date;
}

interface ReportDecisionRow {
  readonly event_id: string;
  readonly signature: string;
  readonly outer_instruction_index: number;
  readonly inner_instruction_index: number | null;
  readonly invoice_id: string | null;
  readonly amount_base_units: string;
  readonly rule_code: ReportDecision["ruleCode"];
  readonly rule_version: string;
}

function reportInvoice(row: ReportInvoiceRow): ReportInvoice {
  return {
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    status: row.status,
    expectedMint: row.expected_mint,
    amountBaseUnits: row.amount_base_units,
    referenceAddress: row.reference_address,
    issuedAt: row.issued_at.toISOString(),
    dueAt: row.due_at.toISOString(),
  };
}

function reportDecision(row: ReportDecisionRow): ReportDecision {
  return {
    eventId: row.event_id,
    signature: row.signature,
    outerInstructionIndex: row.outer_instruction_index,
    innerInstructionIndex: row.inner_instruction_index,
    invoiceId: row.invoice_id,
    amountBaseUnits: row.amount_base_units,
    ruleCode: row.rule_code,
    ruleVersion: row.rule_version,
  };
}

export async function loadReportRows(
  sql: Sql,
): Promise<readonly ReconciliationReportRow[]> {
  const rows = await sql<
    Array<{
      invoice_id: string;
      customer_id: string;
      status: ReconciliationReportRow["status"];
      expected_mint: string;
      amount_base_units: string;
      event_id: string | null;
      rule_code: ReconciliationReportRow["ruleCode"];
    }>
  >`
    SELECT
      invoice.invoice_id,
      invoice.customer_id,
      invoice.status,
      invoice.expected_mint,
      invoice.amount_base_units::text,
      event.event_id,
      COALESCE(allocation.rule_code, exception.rule_code) AS rule_code
    FROM reconciliation_invoices AS invoice
    LEFT JOIN reconciliation_allocations AS allocation
      ON allocation.invoice_id = invoice.invoice_id
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM reconciliation_exceptions AS candidate
      WHERE candidate.invoice_id = invoice.invoice_id
      ORDER BY candidate.id DESC
      LIMIT 1
    ) AS exception ON true
    LEFT JOIN chain_events AS event
      ON event.id = COALESCE(allocation.chain_event_id, exception.chain_event_id)
    UNION ALL
    SELECT
      '' AS invoice_id,
      '' AS customer_id,
      'unapplied' AS status,
      transfer.mint AS expected_mint,
      exception.amount_base_units::text,
      event.event_id,
      exception.rule_code
    FROM reconciliation_exceptions AS exception
    JOIN chain_events AS event ON event.id = exception.chain_event_id
    JOIN LATERAL (
      SELECT normalized.* FROM normalized_transfers AS normalized
      WHERE normalized.chain_event_id = event.id
      ORDER BY
        payops_semver_key(normalized.parser_version) DESC NULLS LAST,
        normalized.parser_version DESC
      LIMIT 1
    ) AS transfer ON true
    WHERE exception.invoice_id IS NULL
    ORDER BY invoice_id, event_id NULLS LAST
  `;
  return rows.map((row) => ({
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    status: row.status,
    expectedMint: row.expected_mint,
    amountBaseUnits: row.amount_base_units,
    eventId: row.event_id,
    ruleCode: row.rule_code,
  }));
}

export async function loadReport(
  sql: Sql,
  generatedAt: Date,
): Promise<ReconciliationReport> {
  const [invoiceRows, allocationRows, exceptionRows] = await Promise.all([
    sql<ReportInvoiceRow[]>`
      SELECT
        invoice_id, customer_id, status, expected_mint,
        amount_base_units::text, reference_address, issued_at, due_at
      FROM reconciliation_invoices
      ORDER BY invoice_id
    `,
    sql<ReportDecisionRow[]>`
      SELECT
        event_id, signature, outer_instruction_index,
        inner_instruction_index, invoice_id, amount_base_units::text,
        rule_code, rule_version
      FROM reconciliation_allocations
      ORDER BY event_id
    `,
    sql<ReportDecisionRow[]>`
      SELECT
        event_id, signature, outer_instruction_index,
        inner_instruction_index, invoice_id, amount_base_units::text,
        rule_code, rule_version
      FROM reconciliation_exceptions
      ORDER BY event_id
    `,
  ]);
  const invoices = invoiceRows.map(reportInvoice);
  const allocations = allocationRows.map(reportDecision);
  const exceptions = exceptionRows.map(reportDecision);
  return {
    schemaVersion: "0.1",
    generatedAt: generatedAt.toISOString(),
    summary: {
      invoices: invoices.length,
      matched: invoices.filter((invoice) => invoice.status === "matched")
        .length,
      open: invoices.filter((invoice) => invoice.status === "open").length,
      exception: invoices.filter((invoice) => invoice.status === "exception")
        .length,
      allocations: allocations.length,
      exceptions: exceptions.length,
      unapplied: exceptions.filter((exception) => exception.invoiceId === null)
        .length,
    },
    invoices,
    allocations,
    exceptions,
  };
}
