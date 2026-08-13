export const RECONCILIATION_RULE_VERSION = "0.1" as const;

export type InvoiceStatus = "open" | "matched" | "exception";

export type ReconciliationRuleCode =
  | "exact_match"
  | "missing_reference"
  | "unknown_reference"
  | "ambiguous_reference"
  | "duplicate_payment"
  | "wrong_asset"
  | "wrong_destination"
  | "missing_block_time"
  | "before_issue"
  | "late_payment"
  | "partial_payment"
  | "excess_payment";

export type ReconciliationErrorCode =
  | "invalid_invoice_csv"
  | "invoice_import_conflict"
  | "database_unavailable"
  | "invalid_configuration";

export class ReconciliationError extends Error {
  public readonly code: ReconciliationErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ReconciliationErrorCode,
    message: string,
    options: { readonly retryable: boolean; readonly cause?: unknown },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ReconciliationError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

export interface InvoiceImport {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly expectedMint: string;
  readonly destinationTokenAccount: string;
  readonly amountBaseUnits: bigint;
  readonly referenceAddress: string;
  readonly issuedAt: Date;
  readonly dueAt: Date;
}

export interface InvoiceRecord extends InvoiceImport {
  readonly status: InvoiceStatus;
}

export interface FinalizedPaymentEvent {
  readonly chainEventId: string;
  readonly eventId: string;
  readonly cluster: "mainnet-beta" | "devnet" | "localnet";
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly mint: string;
  readonly destinationTokenAccount: string;
  readonly amountBaseUnits: bigint;
  readonly decimals: number;
  readonly references: readonly string[];
  readonly blockTime: Date | null;
}

export interface AllocationDecision {
  readonly kind: "allocation";
  readonly code: "exact_match";
  readonly ruleVersion: typeof RECONCILIATION_RULE_VERSION;
  readonly eventId: string;
  readonly chainEventId: string;
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly invoiceId: string;
  readonly amountBaseUnits: bigint;
}

export interface ExceptionDecision {
  readonly kind: "exception";
  readonly code: Exclude<ReconciliationRuleCode, "exact_match">;
  readonly ruleVersion: typeof RECONCILIATION_RULE_VERSION;
  readonly eventId: string;
  readonly chainEventId: string;
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly invoiceId: string | null;
  readonly amountBaseUnits: bigint;
}

export type ReconciliationDecision = AllocationDecision | ExceptionDecision;
