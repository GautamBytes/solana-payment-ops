import type { Sql } from "postgres";
import type { InvoiceStatus } from "../domain/types.js";
import type { ReconciliationReportRow } from "../report/csv-report.js";
import type {
  ReconciliationReport,
  ReportDecision,
  ReportInvoice,
} from "../report/json-report.js";
import type { ReconciliationAuditSummary } from "./types.js";

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

export async function loadAuditSummary(
  sql: Sql,
  invoiceIds: readonly string[],
  watchTargetIds: readonly string[],
): Promise<ReconciliationAuditSummary> {
  const [totals, exceptionRows] = await Promise.all([
    sql<
      {
        invoice_count: number;
        allocation_count: number;
        exception_count: number;
        unmatched_finalized_events: number;
      }[]
    >`
      WITH selected_events AS (
        SELECT DISTINCT event.id
        FROM chain_events AS event
        JOIN discovered_signatures AS signature
          ON signature.signature = event.signature
         AND signature.finality_state = 'finalized'
        WHERE event.cluster = 'mainnet-beta'
          AND event.current_state = 'finalized'
          AND signature.watch_target_id = ANY(${watchTargetIds}::text[])
      ), selected_allocations AS (
        SELECT allocation.chain_event_id
        FROM reconciliation_allocations AS allocation
        WHERE allocation.invoice_id = ANY(${invoiceIds}::text[])
          AND allocation.chain_event_id IN (SELECT id FROM selected_events)
      ), selected_exceptions AS (
        SELECT exception.chain_event_id
        FROM reconciliation_exceptions AS exception
        WHERE exception.chain_event_id IN (SELECT id FROM selected_events)
          AND (
            exception.invoice_id = ANY(${invoiceIds}::text[])
            OR exception.invoice_id IS NULL
          )
      )
      SELECT
        (SELECT count(*)::integer FROM reconciliation_invoices
          WHERE invoice_id = ANY(${invoiceIds}::text[])) AS invoice_count,
        (SELECT count(*)::integer FROM selected_allocations) AS allocation_count,
        (SELECT count(*)::integer FROM selected_exceptions) AS exception_count,
        (SELECT count(*)::integer FROM selected_events AS event
          WHERE event.id NOT IN (SELECT chain_event_id FROM selected_allocations)
            AND event.id NOT IN (SELECT chain_event_id FROM selected_exceptions)
        ) AS unmatched_finalized_events
    `,
    sql<{ rule_code: string; count: number }[]>`
      WITH selected_events AS (
        SELECT DISTINCT event.id
        FROM chain_events AS event
        JOIN discovered_signatures AS signature
          ON signature.signature = event.signature
         AND signature.finality_state = 'finalized'
        WHERE event.cluster = 'mainnet-beta'
          AND event.current_state = 'finalized'
          AND signature.watch_target_id = ANY(${watchTargetIds}::text[])
      )
      SELECT exception.rule_code, count(*)::integer AS count
      FROM reconciliation_exceptions AS exception
      JOIN selected_events AS event ON event.id = exception.chain_event_id
      WHERE (
          exception.invoice_id = ANY(${invoiceIds}::text[])
          OR exception.invoice_id IS NULL
        )
      GROUP BY exception.rule_code
      ORDER BY exception.rule_code
    `,
  ]);
  const total = totals[0];
  return {
    invoiceCount: total?.invoice_count ?? 0,
    allocationCount: total?.allocation_count ?? 0,
    exceptionCount: total?.exception_count ?? 0,
    exceptionsByCode: Object.fromEntries(
      exceptionRows.map((row) => [row.rule_code, row.count]),
    ),
    unmatchedFinalizedEvents: total?.unmatched_finalized_events ?? 0,
  };
}

export async function loadAuditRows(
  sql: Sql,
  invoiceIds: readonly string[],
  watchTargetIds: readonly string[],
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
    WITH selected_events AS (
      SELECT DISTINCT event.id
      FROM chain_events AS event
      JOIN discovered_signatures AS signature
        ON signature.signature = event.signature
       AND signature.finality_state = 'finalized'
      WHERE event.cluster = 'mainnet-beta'
        AND event.current_state = 'finalized'
        AND signature.watch_target_id = ANY(${watchTargetIds}::text[])
    )
    SELECT
      invoice.invoice_id,
      invoice.customer_id,
      CASE
        WHEN allocation.chain_event_id IS NOT NULL THEN 'matched'
        WHEN exception.chain_event_id IS NOT NULL THEN 'exception'
        ELSE 'open'
      END AS status,
      invoice.expected_mint,
      invoice.amount_base_units::text,
      event.event_id,
      COALESCE(allocation.rule_code, exception.rule_code) AS rule_code
    FROM reconciliation_invoices AS invoice
    LEFT JOIN reconciliation_allocations AS allocation
      ON allocation.invoice_id = invoice.invoice_id
     AND allocation.chain_event_id IN (SELECT id FROM selected_events)
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM reconciliation_exceptions AS candidate
      WHERE candidate.invoice_id = invoice.invoice_id
        AND candidate.chain_event_id IN (SELECT id FROM selected_events)
      ORDER BY candidate.id DESC
      LIMIT 1
    ) AS exception ON true
    LEFT JOIN chain_events AS event
      ON event.id = COALESCE(allocation.chain_event_id, exception.chain_event_id)
    WHERE invoice.invoice_id = ANY(${invoiceIds}::text[])
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
    JOIN selected_events AS selected ON selected.id = exception.chain_event_id
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
