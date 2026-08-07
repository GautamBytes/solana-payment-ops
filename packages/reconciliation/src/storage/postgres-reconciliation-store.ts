import { createHash, randomUUID } from "node:crypto";
import { stringifyCanonical } from "@payops/core";
import postgres, { type Sql } from "postgres";
import type {
  FinalizedPaymentEvent,
  InvoiceImport,
  InvoiceRecord,
  ReconciliationDecision,
} from "../domain/types.js";
import { ReconciliationError } from "../domain/types.js";
import type { ReconciliationReportRow } from "../report/csv-report.js";
import type { ReconciliationReport } from "../report/json-report.js";
import { loadReport, loadReportRows } from "./postgres-report-store.js";
import type { OperatorReconciliationStore } from "./types.js";

interface InvoiceRow {
  readonly invoice_id: string;
  readonly customer_id: string;
  readonly expected_mint: string;
  readonly destination_token_account: string;
  readonly amount_base_units: string;
  readonly reference_address: string;
  readonly issued_at: Date;
  readonly due_at: Date;
  readonly row_digest: string;
  readonly status: InvoiceRecord["status"];
}

interface EventRow {
  readonly chain_event_id: string;
  readonly event_id: string;
  readonly cluster: "mainnet-beta";
  readonly signature: string;
  readonly outer_instruction_index: number;
  readonly inner_instruction_index: number;
  readonly mint: string;
  readonly destination_token_account: string;
  readonly amount_base_units: string;
  readonly decimals: number;
  readonly references: string[];
  readonly block_time: Date | null;
}

function digestInvoice(invoice: InvoiceImport): string {
  return createHash("sha256")
    .update(
      stringifyCanonical({
        invoiceId: invoice.invoiceId,
        customerId: invoice.customerId,
        expectedMint: invoice.expectedMint,
        destinationTokenAccount: invoice.destinationTokenAccount,
        amountBaseUnits: invoice.amountBaseUnits.toString(),
        referenceAddress: invoice.referenceAddress,
        issuedAt: invoice.issuedAt.toISOString(),
        dueAt: invoice.dueAt.toISOString(),
      }),
    )
    .digest("hex");
}

function invoiceRecord(row: InvoiceRow): InvoiceRecord {
  return {
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    expectedMint: row.expected_mint,
    destinationTokenAccount: row.destination_token_account,
    amountBaseUnits: BigInt(row.amount_base_units),
    referenceAddress: row.reference_address,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    status: row.status,
  };
}

export interface PostgresReconciliationStoreConfig {
  readonly databaseUrl: string;
}

export class PostgresReconciliationStore implements OperatorReconciliationStore {
  readonly #sql: Sql;

  public constructor(config: PostgresReconciliationStoreConfig) {
    this.#sql = postgres(config.databaseUrl);
  }

  public async startRun(startedAt: Date): Promise<string> {
    const id = randomUUID();
    await this.#sql`
      INSERT INTO reconciliation_runs (id, started_at)
      VALUES (${id}, ${startedAt.toISOString()})
    `;
    return id;
  }

  public async completeRun(
    runId: string,
    result: "complete" | "failed",
    counts: {
      readonly candidates: number;
      readonly allocations: number;
      readonly exceptions: number;
      readonly applied: number;
    },
    completedAt: Date,
  ): Promise<void> {
    await this.#sql`
      UPDATE reconciliation_runs SET
        result = ${result}, candidates = ${counts.candidates},
        allocations = ${counts.allocations}, exceptions = ${counts.exceptions},
        applied = ${counts.applied}, completed_at = ${completedAt.toISOString()}
      WHERE id = ${runId} AND result = 'running'
    `;
  }

  public async importInvoices(
    invoices: readonly InvoiceImport[],
    importedAt: Date,
  ): Promise<{ readonly inserted: number; readonly existing: number }> {
    return this.#sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended('reconciliation:invoice-import', 0))
      `;
      let inserted = 0;
      let existing = 0;
      for (const invoice of invoices) {
        const digest = digestInvoice(invoice);
        const rows = await transaction<InvoiceRow[]>`
          SELECT * FROM reconciliation_invoices
          WHERE invoice_id = ${invoice.invoiceId}
             OR reference_address = ${invoice.referenceAddress}
          FOR UPDATE
        `;
        if (rows.length > 0) {
          const row = rows[0];
          if (
            rows.length !== 1 ||
            row?.invoice_id !== invoice.invoiceId ||
            row.reference_address !== invoice.referenceAddress ||
            row.row_digest !== digest
          ) {
            throw new ReconciliationError(
              "invoice_import_conflict",
              "Invoice ID or reference already has different immutable data",
              { retryable: false },
            );
          }
          existing += 1;
          continue;
        }
        await transaction`
          INSERT INTO reconciliation_invoices (
            invoice_id, customer_id, expected_mint, destination_token_account,
            amount_base_units, reference_address, issued_at, due_at,
            row_digest, imported_at
          ) VALUES (
            ${invoice.invoiceId}, ${invoice.customerId}, ${invoice.expectedMint},
            ${invoice.destinationTokenAccount}, ${invoice.amountBaseUnits.toString()},
            ${invoice.referenceAddress}, ${invoice.issuedAt.toISOString()},
            ${invoice.dueAt.toISOString()}, ${digest}, ${importedAt.toISOString()}
          )
        `;
        inserted += 1;
      }
      return { inserted, existing };
    });
  }

  public async listInvoices(): Promise<readonly InvoiceRecord[]> {
    const rows = await this.#sql<InvoiceRow[]>`
      SELECT * FROM reconciliation_invoices ORDER BY invoice_id
    `;
    return rows.map(invoiceRecord);
  }

  public async listFinalizedCandidates(): Promise<
    readonly FinalizedPaymentEvent[]
  > {
    const rows = await this.#sql<EventRow[]>`
      SELECT
        event.id::text AS chain_event_id,
        event.event_id,
        event.cluster,
        event.signature,
        event.outer_instruction_index,
        event.inner_instruction_index,
        transfer.mint,
        transfer.destination_token_account,
        transfer.amount_base_units::text,
        transfer.decimals,
        ARRAY(
          SELECT reference.reference_address
          FROM event_references AS reference
          WHERE reference.chain_event_id = event.id
          ORDER BY reference.reference_address
        ) AS references,
        CASE
          WHEN raw.body->>'blockTime' ~ '^[0-9]+$'
            THEN to_timestamp((raw.body->>'blockTime')::double precision)
          ELSE NULL
        END AS block_time
      FROM chain_events AS event
      JOIN LATERAL (
        SELECT normalized.* FROM normalized_transfers AS normalized
        WHERE normalized.chain_event_id = event.id
        ORDER BY normalized.parser_version DESC
        LIMIT 1
      ) AS transfer ON true
      JOIN raw_transactions AS raw ON raw.id = event.raw_transaction_id
      LEFT JOIN reconciliation_allocations AS allocation
        ON allocation.chain_event_id = event.id
      LEFT JOIN reconciliation_exceptions AS exception
        ON exception.chain_event_id = event.id
      WHERE event.current_state = 'finalized'
        AND event.cluster = 'mainnet-beta'
        AND allocation.id IS NULL
        AND exception.id IS NULL
      ORDER BY event.event_id
    `;
    return rows.map((row) => ({
      chainEventId: row.chain_event_id,
      eventId: row.event_id,
      cluster: row.cluster,
      signature: row.signature,
      outerInstructionIndex: row.outer_instruction_index,
      innerInstructionIndex:
        row.inner_instruction_index === -1 ? null : row.inner_instruction_index,
      mint: row.mint,
      destinationTokenAccount: row.destination_token_account,
      amountBaseUnits: BigInt(row.amount_base_units),
      decimals: row.decimals,
      references: row.references,
      blockTime: row.block_time,
    }));
  }

  public async recordDecision(
    decision: ReconciliationDecision,
    decidedAt: Date,
  ): Promise<boolean> {
    return this.#sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${`reconciliation:event:${decision.chainEventId}`}, 0))
      `;
      const existing = await transaction<{ present: boolean }[]>`
        SELECT (
          EXISTS (SELECT 1 FROM reconciliation_allocations WHERE chain_event_id = ${decision.chainEventId})
          OR EXISTS (SELECT 1 FROM reconciliation_exceptions WHERE chain_event_id = ${decision.chainEventId})
        ) AS present
      `;
      if (existing[0]?.present === true) return false;
      if (decision.kind === "allocation") {
        const inserted = await transaction<{ id: string }[]>`
          INSERT INTO reconciliation_allocations (
            invoice_id, chain_event_id, event_id, signature,
            outer_instruction_index, inner_instruction_index,
            amount_base_units, rule_code, rule_version, created_at
          )
          SELECT
            ${decision.invoiceId}, event.id, ${decision.eventId}, ${decision.signature},
            ${decision.outerInstructionIndex}, ${decision.innerInstructionIndex},
            ${decision.amountBaseUnits.toString()},
            ${decision.code}, ${decision.ruleVersion}, ${decidedAt.toISOString()}
          FROM chain_events AS event
          WHERE event.id = ${decision.chainEventId}
            AND event.current_state = 'finalized'
            AND event.cluster = 'mainnet-beta'
          ON CONFLICT DO NOTHING
          RETURNING id::text
        `;
        if (inserted.length === 0) return false;
        await transaction`
          UPDATE reconciliation_invoices SET status = 'matched'
          WHERE invoice_id = ${decision.invoiceId}
        `;
        return true;
      }
      const fingerprint = createHash("sha256")
        .update(
          `${decision.eventId}:${decision.invoiceId ?? ""}:${decision.code}:${decision.ruleVersion}`,
        )
        .digest("hex");
      const inserted = await transaction<{ id: string }[]>`
        INSERT INTO reconciliation_exceptions (
          fingerprint, invoice_id, chain_event_id, event_id, signature,
          outer_instruction_index, inner_instruction_index,
          amount_base_units, rule_code, rule_version, created_at
        )
        SELECT
          ${fingerprint}, ${decision.invoiceId}, event.id, ${decision.eventId},
          ${decision.signature}, ${decision.outerInstructionIndex},
          ${decision.innerInstructionIndex},
          ${decision.amountBaseUnits.toString()}, ${decision.code},
          ${decision.ruleVersion}, ${decidedAt.toISOString()}
        FROM chain_events AS event
        WHERE event.id = ${decision.chainEventId}
          AND event.current_state = 'finalized'
          AND event.cluster = 'mainnet-beta'
        ON CONFLICT DO NOTHING
        RETURNING id::text
      `;
      if (inserted.length === 0) return false;
      if (decision.invoiceId !== null) {
        await transaction`
          UPDATE reconciliation_invoices SET status = 'exception'
          WHERE invoice_id = ${decision.invoiceId} AND status = 'open'
        `;
      }
      return true;
    });
  }

  public async getReportRows(): Promise<readonly ReconciliationReportRow[]> {
    return loadReportRows(this.#sql);
  }

  public async getReport(generatedAt: Date): Promise<ReconciliationReport> {
    return loadReport(this.#sql, generatedAt);
  }

  public async close(): Promise<void> {
    await this.#sql.end();
  }
}
