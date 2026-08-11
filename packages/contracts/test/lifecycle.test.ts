import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_SCHEMA_VERSION,
  parseLifecycleEventEnvelope,
  SUPPORTED_LIFECYCLE_EVENT_TYPES,
  type LifecycleEventEnvelope,
} from "../src/index.js";
import { lifecycleExamples as cases } from "./support/lifecycle-examples.js";
const astral = "\u{1F680}";

describe("lifecycle contract", () => {
  it("exports the exact v0.1 event vocabulary", () => {
    expect(LIFECYCLE_SCHEMA_VERSION).toBe("0.1");
    expect(SUPPORTED_LIFECYCLE_EVENT_TYPES).toEqual([
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
    ]);
  });

  it.each(cases)("accepts $type with its exact object and data", (event) => {
    expect(parseLifecycleEventEnvelope(event)).toEqual(event);
  });

  it("accepts exact Unicode code-point boundaries", () => {
    const event = structuredClone(cases[8]) as MutableEnvelope;
    event.object.id = astral.repeat(128);
    event.data.invoiceId = astral.repeat(128);
    event.data.customerId = astral.repeat(512);

    expect(parseLifecycleEventEnvelope(event)).toEqual(event);
  });

  it.each([
    [
      "wrong object pairing",
      mutate(cases[0], (event) => (event.object.type = "payment")),
    ],
    ["unknown envelope key", { ...cases[0], unknown: true }],
    [
      "unknown object key",
      mutate(cases[0], (event) => (event.object.unknown = true)),
    ],
    [
      "unknown data key",
      mutate(cases[0], (event) => (event.data.unknown = true)),
    ],
    [
      "uppercase UUID",
      { ...cases[0], id: "00000000-0000-4000-8000-00000000000A" },
    ],
    ["invalid UUID", { ...cases[0], id: "event-001" }],
    [
      "noncanonical timestamp",
      { ...cases[0], occurredAt: "2026-08-11T12:00:00Z" },
    ],
    [
      "oversized object ID",
      mutate(cases[8], (event) => (event.object.id = astral.repeat(129))),
    ],
    [
      "oversized customer ID",
      mutate(cases[8], (event) => (event.data.customerId = astral.repeat(513))),
    ],
    [
      "noncanonical base units",
      mutate(cases[8], (event) => (event.data.amountBaseUnits = "01")),
    ],
    [
      "over-u64 base units",
      mutate(
        cases[8],
        (event) => (event.data.amountBaseUnits = "18446744073709551616"),
      ),
    ],
    [
      "invalid signature",
      mutate(cases[8], (event) => (event.data.signature = "not-base58")),
    ],
    [
      "invalid mint",
      mutate(cases[8], (event) => (event.data.mint = "not-solana")),
    ],
    [
      "negative instruction index",
      mutate(cases[8], (event) => (event.data.outerInstructionIndex = -1)),
    ],
    [
      "unsupported review state",
      mutate(cases[6], (event) => (event.data.reviewState = "pending")),
    ],
    [
      "event-specific commitment mismatch",
      mutate(cases[2], (event) => (event.data.commitment = "finalized")),
    ],
    [
      "object and data identity mismatch",
      mutate(cases[11], (event) => (event.data.refundId = "refund-002")),
    ],
  ])("rejects %s", (_name, event) => {
    expect(parseLifecycleEventEnvelope(event)).toBeNull();
  });

  it("parses semantically identical noncanonical key order", () => {
    const original = cases[8];
    const reordered = {
      type: original.type,
      schemaVersion: original.schemaVersion,
      data: Object.fromEntries(Object.entries(original.data).reverse()),
      object: Object.fromEntries(Object.entries(original.object).reverse()),
      statusAtOccurrence: original.statusAtOccurrence,
      occurredAt: original.occurredAt,
      id: original.id,
    };

    expect(parseLifecycleEventEnvelope(reordered)).toEqual(reordered);
  });
});

type MutableEnvelope = {
  schemaVersion: string;
  id: string;
  type: string;
  occurredAt: string;
  statusAtOccurrence: string;
  object: Record<string, any>;
  data: Record<string, any>;
};

function mutate(
  source: LifecycleEventEnvelope,
  change: (event: MutableEnvelope) => void,
): MutableEnvelope {
  const copy = structuredClone(source) as unknown as MutableEnvelope;
  change(copy);
  return copy;
}
