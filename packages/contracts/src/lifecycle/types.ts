import type { ExceptionCode } from "../exception-taxonomy.js";

export const LIFECYCLE_SCHEMA_VERSION = "0.1" as const;

export const SUPPORTED_LIFECYCLE_EVENT_TYPES = [
  "invoice.issued",
  "invoice.cancelled",
  "payment.detected",
  "payment.confirmed",
  "payment.finalized",
  "payment.confirmation_revoked",
  "payment.exception_created",
  "invoice.partial",
  "invoice.paid",
  "invoice.overpaid",
  "refund.prepared",
  "refund.finalized",
  "evidence.ready",
] as const;

export type LifecycleEventType =
  (typeof SUPPORTED_LIFECYCLE_EVENT_TYPES)[number];

export type LifecycleObjectType =
  "invoice" | "payment" | "payment_exception" | "refund" | "evidence_pack";

export interface LifecycleObject<Type extends LifecycleObjectType> {
  readonly type: Type;
  readonly id: string;
  readonly version: number;
}

export type InvoiceObject = LifecycleObject<"invoice">;
export type PaymentObject = LifecycleObject<"payment">;
export type PaymentExceptionObject = LifecycleObject<"payment_exception">;
export type RefundObject = LifecycleObject<"refund">;
export type EvidencePackObject = LifecycleObject<"evidence_pack">;

export type LifecycleObjectTypeForEvent<Type extends LifecycleEventType> =
  Type extends `invoice.${string}`
    ? "invoice"
    : Type extends "payment.exception_created"
      ? "payment_exception"
      : Type extends `payment.${string}`
        ? "payment"
        : Type extends `refund.${string}`
          ? "refund"
          : Type extends "evidence.ready"
            ? "evidence_pack"
            : never;

export interface InvoiceIssuedData {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly publicReference: string;
  readonly currency: "USD" | "EUR" | "GBP" | "INR";
  readonly totalMinorUnits: string;
  readonly dueAt: string;
  readonly issuedAt: string;
  readonly acceptedAssetSymbols: readonly ("USDC" | "USDT")[];
}

export interface InvoiceCancelledData {
  readonly invoiceId: string;
  readonly publicReference: string;
  readonly previousState: "draft" | "issued";
  readonly reasonCode:
    | "customer_request"
    | "duplicate_invoice"
    | "commercial_terms_changed"
    | "merchant_error"
    | "other_reviewed";
  readonly actorKind: "member" | "api_key";
  readonly cancelledAt: string;
}

export interface PaymentObservedData {
  readonly paymentAttemptId: string;
  readonly invoiceId: string;
  readonly eventId: string;
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly mint: string;
  readonly amountBaseUnits: string;
  readonly commitment: "detected" | "confirmed" | "finalized";
}

export interface PaymentConfirmationRevokedData {
  readonly paymentAttemptId: string;
  readonly invoiceId: string;
  readonly eventId: string;
  readonly signature: string;
  readonly previousState: "detected" | "confirmed";
  readonly currentState: "failed" | "reverted" | "quarantined";
  readonly code: string;
}

export interface PaymentExceptionCreatedData {
  readonly exceptionId: string;
  readonly invoiceId: string | null;
  readonly eventId: string;
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly amountBaseUnits: string;
  readonly code: ExceptionCode;
  readonly ruleVersion: string;
  readonly reviewState: "open" | "resolved" | "ignored";
}

export interface InvoiceBalanceChangedData {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly eventId: string;
  readonly allocatedBaseUnits: string;
  readonly outstandingBaseUnits: string;
  readonly mint: string;
  readonly ruleVersion: string;
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

export interface InvoiceOverpaidData extends InvoiceBalanceChangedData {
  readonly excessBaseUnits: string;
}

export interface RefundPreparedData {
  readonly refundId: string;
  readonly invoiceId: string;
  readonly allocationId: string;
  readonly mint: string;
  readonly amountBaseUnits: string;
  readonly returnOwner: string;
  readonly approvalState: "pending" | "approved";
}

export interface RefundFinalizedData {
  readonly refundId: string;
  readonly invoiceId: string;
  readonly signature: string;
  readonly eventId: string;
  readonly mint: string;
  readonly amountBaseUnits: string;
}

export interface EvidenceReadyData {
  readonly evidencePackId: string;
  readonly invoiceId: string;
  readonly manifestDigest: string;
  readonly signingKeyId: string;
  readonly resourceId: string;
}

export interface LifecycleEventDataByType {
  readonly "invoice.issued": InvoiceIssuedData;
  readonly "invoice.cancelled": InvoiceCancelledData;
  readonly "payment.detected": PaymentObservedData;
  readonly "payment.confirmed": PaymentObservedData;
  readonly "payment.finalized": PaymentObservedData;
  readonly "payment.confirmation_revoked": PaymentConfirmationRevokedData;
  readonly "payment.exception_created": PaymentExceptionCreatedData;
  readonly "invoice.partial": InvoiceBalanceChangedData;
  readonly "invoice.paid": InvoicePaidData;
  readonly "invoice.overpaid": InvoiceOverpaidData;
  readonly "refund.prepared": RefundPreparedData;
  readonly "refund.finalized": RefundFinalizedData;
  readonly "evidence.ready": EvidenceReadyData;
}

export interface LifecycleEventBase<
  Type extends LifecycleEventType,
  ObjectType extends LifecycleObjectType,
  Data extends object,
> {
  readonly type: Type;
  readonly statusAtOccurrence: string;
  readonly object: LifecycleObject<ObjectType>;
  readonly data: Data;
}

export type LifecycleEvent = {
  readonly [Type in LifecycleEventType]: LifecycleEventBase<
    Type,
    LifecycleObjectTypeForEvent<Type>,
    LifecycleEventDataByType[Type]
  >;
}[LifecycleEventType];

export type LifecycleEventEnvelope = {
  readonly [Type in LifecycleEventType]: LifecycleEventBase<
    Type,
    LifecycleObjectTypeForEvent<Type>,
    LifecycleEventDataByType[Type]
  > & {
    readonly schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
    readonly id: string;
    readonly occurredAt: string;
  };
}[LifecycleEventType];

export type InvoicePaidLifecycleEvent = Extract<
  LifecycleEvent,
  { readonly type: "invoice.paid" }
>;
export type PaymentExceptionCreatedLifecycleEvent = Extract<
  LifecycleEvent,
  { readonly type: "payment.exception_created" }
>;
export type GenericLifecycleEventType = Exclude<
  LifecycleEventType,
  "invoice.paid" | "payment.exception_created"
>;
export type GenericLifecycleEvent = Extract<
  LifecycleEvent,
  { readonly type: GenericLifecycleEventType }
>;
