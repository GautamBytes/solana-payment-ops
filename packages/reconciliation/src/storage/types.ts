import type {
  FinalizedPaymentEvent,
  InvoiceImport,
  InvoiceRecord,
  ReconciliationDecision,
} from "../domain/types.js";
import type { ReconciliationReportRow } from "../report/csv-report.js";
import type { ReconciliationReport } from "../report/json-report.js";

export interface ReconciliationStore {
  startRun(startedAt: Date): Promise<string>;
  completeRun(
    runId: string,
    result: "complete" | "failed",
    counts: {
      readonly candidates: number;
      readonly allocations: number;
      readonly exceptions: number;
      readonly applied: number;
    },
    completedAt: Date,
  ): Promise<void>;
  listInvoices(): Promise<readonly InvoiceRecord[]>;
  listFinalizedCandidates(): Promise<readonly FinalizedPaymentEvent[]>;
  recordDecision(
    decision: ReconciliationDecision,
    decidedAt: Date,
  ): Promise<boolean>;
}

export interface OperatorReconciliationStore extends ReconciliationStore {
  importInvoices(
    invoices: readonly InvoiceImport[],
    importedAt: Date,
  ): Promise<{ readonly inserted: number; readonly existing: number }>;
  getReportRows(): Promise<readonly ReconciliationReportRow[]>;
  getReport(generatedAt: Date): Promise<ReconciliationReport>;
  close(): Promise<void>;
}
