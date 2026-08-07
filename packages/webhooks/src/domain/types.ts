export const SUPPORTED_LIFECYCLE_EVENT_TYPES = [
  "invoice.issued",
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

export type InvoicePaidLifecycleEvent = LifecycleEventBase<
  "invoice.paid",
  "invoice",
  InvoicePaidData
>;

export type PaymentExceptionCreatedLifecycleEvent = LifecycleEventBase<
  "payment.exception_created",
  "payment_exception",
  PaymentExceptionCreatedData
>;

export type GenericLifecycleEventType = Exclude<
  LifecycleEventType,
  "invoice.paid" | "payment.exception_created"
>;

export type GenericLifecycleEvent = {
  readonly [Type in GenericLifecycleEventType]: LifecycleEventBase<
    Type,
    LifecycleObjectTypeForEvent<Type>,
    Record<string, never>
  >;
}[GenericLifecycleEventType];

export type LifecycleEvent =
  | InvoicePaidLifecycleEvent
  | PaymentExceptionCreatedLifecycleEvent
  | GenericLifecycleEvent;

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
