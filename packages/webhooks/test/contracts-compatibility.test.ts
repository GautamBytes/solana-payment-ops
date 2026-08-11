import {
  parseLifecycleEventEnvelope as parseFromContracts,
  SUPPORTED_LIFECYCLE_EVENT_TYPES as contractEventTypes,
} from "@payops/contracts";
import { describe, expect, it } from "vitest";
import {
  parseLifecycleEventEnvelope as parseFromWebhooks,
  SUPPORTED_LIFECYCLE_EVENT_TYPES as webhookEventTypes,
  type GenericLifecycleEvent,
  type GenericLifecycleEventType,
  type EvidencePackObject,
  type InvoiceObject,
  type InvoicePaidData,
  type InvoicePaidLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventBase,
  type LifecycleEventEnvelope,
  type LifecycleEventType,
  type LifecycleObject,
  type LifecycleObjectType,
  type LifecycleObjectTypeForEvent,
  type PaymentExceptionCreatedData,
  type PaymentExceptionCreatedLifecycleEvent,
  type PaymentExceptionObject,
  type PaymentObject,
  type RefundObject,
} from "../src/index.js";

const compatibilitySurface = <T>(value: T): T => value;
void compatibilitySurface<LifecycleEventType>;
void compatibilitySurface<LifecycleObjectType>;
void compatibilitySurface<LifecycleObjectTypeForEvent<"invoice.paid">>;
void compatibilitySurface<LifecycleObject<"invoice">>;
void compatibilitySurface<InvoiceObject>;
void compatibilitySurface<PaymentObject>;
void compatibilitySurface<PaymentExceptionObject>;
void compatibilitySurface<RefundObject>;
void compatibilitySurface<EvidencePackObject>;
void compatibilitySurface<InvoicePaidData>;
void compatibilitySurface<PaymentExceptionCreatedData>;
void compatibilitySurface<
  LifecycleEventBase<"invoice.paid", "invoice", InvoicePaidData>
>;
void compatibilitySurface<InvoicePaidLifecycleEvent>;
void compatibilitySurface<PaymentExceptionCreatedLifecycleEvent>;
void compatibilitySurface<GenericLifecycleEventType>;
void compatibilitySurface<GenericLifecycleEvent>;
void compatibilitySurface<LifecycleEvent>;
void compatibilitySurface<LifecycleEventEnvelope>;

const invoicePaidEnvelope = {
  schemaVersion: "0.1",
  id: "00000000-0000-4000-8000-000000000001",
  type: "invoice.paid",
  occurredAt: "2026-08-11T12:00:00.000Z",
  statusAtOccurrence: "paid",
  object: { type: "invoice", id: "invoice-001", version: 1 },
  data: {
    invoiceId: "invoice-001",
    customerId: "customer-001",
    eventId: "chain-event-001",
    signature:
      "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T",
    outerInstructionIndex: 0,
    innerInstructionIndex: null,
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountBaseUnits: "12500000",
    ruleCode: "exact_match",
    ruleVersion: "0.1",
  },
} as const;

describe("@payops/webhooks lifecycle compatibility", () => {
  it("re-exports the contracts parser and complete event vocabulary", () => {
    expect(parseFromWebhooks).toBe(parseFromContracts);
    expect(webhookEventTypes).toBe(contractEventTypes);
  });

  it("returns the same strict result through both package entrypoints", () => {
    expect(parseFromWebhooks(invoicePaidEnvelope)).toEqual(
      parseFromContracts(invoicePaidEnvelope),
    );

    const uppercaseUuid = {
      ...invoicePaidEnvelope,
      id: "00000000-0000-4000-8000-00000000000A",
    };
    expect(parseFromWebhooks(uppercaseUuid)).toBeNull();
    expect(parseFromContracts(uppercaseUuid)).toBeNull();
  });
});
