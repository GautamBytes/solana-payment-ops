export type LifecycleEventType = "invoice.paid" | "payment.exception_created";

export interface InvoiceObject {
  readonly type: "invoice";
  readonly id: string;
  readonly version: number;
}

export interface PaymentExceptionObject {
  readonly type: "payment_exception";
  readonly id: string;
  readonly version: number;
}

export interface InvoicePaidData {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly eventId: string;
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly mint: string;
  readonly amountBaseUnits: string;
  readonly ruleCode: string;
  readonly ruleVersion: string;
}

export interface PaymentExceptionCreatedData {
  readonly exceptionId: string;
  readonly invoiceId: string | null;
  readonly eventId: string;
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly amountBaseUnits: string;
  readonly code: string;
  readonly ruleVersion: string;
  readonly reviewState: "open" | "resolved" | "ignored";
}

export interface InvoicePaidLifecycleEvent {
  readonly type: "invoice.paid";
  readonly object: InvoiceObject;
  readonly data: InvoicePaidData;
}

export interface PaymentExceptionCreatedLifecycleEvent {
  readonly type: "payment.exception_created";
  readonly object: PaymentExceptionObject;
  readonly data: PaymentExceptionCreatedData;
}

export type LifecycleEvent =
  InvoicePaidLifecycleEvent | PaymentExceptionCreatedLifecycleEvent;

export interface LifecycleEventRecord {
  readonly id: string;
  readonly eventType: LifecycleEventType;
  readonly sourceType: LifecycleEvent["object"]["type"];
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly occurredAt: Date;
  readonly payload: string;
  readonly digest: string;
}

export interface WebhookRequest {
  readonly body: string;
  readonly timestamp: string;
  readonly signature: string;
}

export type VerificationFailureCode =
  | "invalid_verification_options"
  | "malformed_timestamp"
  | "malformed_signature"
  | "unsupported_signature_version"
  | "timestamp_outside_tolerance"
  | "signature_mismatch";

export type VerificationResult =
  | { readonly ok: true; readonly secretIndex: number }
  | { readonly ok: false; readonly code: VerificationFailureCode };
