import type { InvoiceStatus, ReconciliationRuleCode } from "../domain/types.js";

export interface ReportInvoice {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly status: InvoiceStatus;
  readonly expectedMint: string;
  readonly amountBaseUnits: string;
  readonly referenceAddress: string;
  readonly issuedAt: string;
  readonly dueAt: string;
}

export interface ReportDecision {
  readonly eventId: string;
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly invoiceId: string | null;
  readonly amountBaseUnits: string;
  readonly ruleCode: ReconciliationRuleCode;
  readonly ruleVersion: string;
}

export interface ReconciliationReport {
  readonly schemaVersion: "0.1";
  readonly generatedAt: string;
  readonly summary: {
    readonly invoices: number;
    readonly matched: number;
    readonly open: number;
    readonly exception: number;
    readonly allocations: number;
    readonly exceptions: number;
    readonly unapplied: number;
  };
  readonly invoices: readonly ReportInvoice[];
  readonly allocations: readonly ReportDecision[];
  readonly exceptions: readonly ReportDecision[];
}
