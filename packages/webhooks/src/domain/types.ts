import type {
  LifecycleEventType,
  LifecycleObjectType,
} from "@payops/contracts";

export { SUPPORTED_LIFECYCLE_EVENT_TYPES } from "@payops/contracts";
export type {
  EvidencePackObject,
  GenericLifecycleEvent,
  GenericLifecycleEventType,
  InvoiceObject,
  InvoicePaidData,
  InvoicePaidLifecycleEvent,
  LifecycleEvent,
  LifecycleEventBase,
  LifecycleEventType,
  LifecycleObject,
  LifecycleObjectType,
  LifecycleObjectTypeForEvent,
  PaymentExceptionCreatedData,
  PaymentExceptionCreatedLifecycleEvent,
  PaymentExceptionObject,
  PaymentObject,
  RefundObject,
} from "@payops/contracts";

export interface LifecycleEventRecord {
  readonly id: string;
  readonly eventType: LifecycleEventType;
  readonly sourceType: LifecycleObjectType;
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
