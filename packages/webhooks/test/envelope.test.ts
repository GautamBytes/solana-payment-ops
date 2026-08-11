import { describe, expect, it } from "vitest";
import {
  createLifecycleEvent,
  parseLifecycleEventEnvelope,
  SUPPORTED_LIFECYCLE_EVENT_TYPES,
  type LifecycleEvent,
} from "../src/index.js";
import {
  lifecycleInputs,
  TEST_MINT,
  TEST_SIGNATURE,
} from "./support/lifecycle-events.js";

const occurredAt = new Date("2026-08-07T00:00:00.000Z");
const eventId = "00000000-0000-4000-8000-000000000001";
const astral = "\u{1F680}";

describe("createLifecycleEvent", () => {
  it("creates canonical bytes and a stable digest", () => {
    const event = createLifecycleEvent(lifecycleInputs[8], eventId, occurredAt);

    expect(event).toMatchObject({
      id: eventId,
      eventType: "invoice.paid",
      sourceType: "invoice",
      sourceId: "invoice-001",
      sourceVersion: 1,
      occurredAt,
    });
    expect(event.payload).toBe(
      [
        "{",
        '  "data": {',
        '    "amountBaseUnits": "12500000",',
        '    "customerId": "customer-001",',
        '    "eventId": "chain-event-001",',
        '    "innerInstructionIndex": null,',
        '    "invoiceId": "invoice-001",',
        `    "mint": "${TEST_MINT}",`,
        '    "outerInstructionIndex": 0,',
        '    "ruleCode": "exact_match",',
        '    "ruleVersion": "0.1",',
        `    "signature": "${TEST_SIGNATURE}"`,
        "  },",
        `  "id": "${eventId}",`,
        '  "object": {',
        '    "id": "invoice-001",',
        '    "type": "invoice",',
        '    "version": 1',
        "  },",
        '  "occurredAt": "2026-08-07T00:00:00.000Z",',
        '  "schemaVersion": "0.1",',
        '  "statusAtOccurrence": "paid",',
        '  "type": "invoice.paid"',
        "}",
        "",
      ].join("\n"),
    );
    expect(event.digest).toBe(
      "f59daa2e25473b03c3389e63dd3e1d5e3b5418d77f917399c2da70f787a2e346",
    );
  });

  it("exposes the exact v0.1 lifecycle vocabulary", () => {
    expect(SUPPORTED_LIFECYCLE_EVENT_TYPES).toEqual(
      lifecycleInputs.map(({ type }) => type),
    );
  });

  it.each(lifecycleInputs)(
    "creates and parses an exact $type envelope",
    (input) => {
      const event = createLifecycleEvent(input, eventId, occurredAt);
      const envelope = JSON.parse(event.payload) as unknown;

      expect(parseLifecycleEventEnvelope(envelope)).toEqual(envelope);
      expect(event.eventType).toBe(input.type);
      expect(event.sourceType).toBe(input.object.type);
      expect(event.sourceId).toBe(input.object.id);
    },
  );

  it("preserves numeric instruction coordinates and string base-unit amounts", () => {
    const event = createLifecycleEvent(
      {
        ...lifecycleInputs[8],
        data: { ...lifecycleInputs[8].data, innerInstructionIndex: 2 },
      },
      eventId,
      occurredAt,
    );
    const payload = JSON.parse(event.payload) as {
      data: Record<string, unknown>;
    };

    expect(payload.data.outerInstructionIndex).toBe(0);
    expect(payload.data.innerInstructionIndex).toBe(2);
    expect(payload.data.amountBaseUnits).toBe("12500000");
  });

  it("rejects unsupported lifecycle event types", () => {
    expect(() =>
      createLifecycleEvent(
        {
          type: "invoice.created",
          statusAtOccurrence: "created",
          object: { type: "invoice", id: "invoice-001", version: 1 },
          data: {},
        } as unknown as LifecycleEvent,
        eventId,
        occurredAt,
      ),
    ).toThrow("Unsupported lifecycle event type: invoice.created");
  });

  it("round-trips exact Unicode code-point boundaries", () => {
    const input: LifecycleEvent = {
      ...lifecycleInputs[8],
      object: { ...lifecycleInputs[8].object, id: astral.repeat(128) },
      data: {
        ...lifecycleInputs[8].data,
        invoiceId: astral.repeat(128),
        customerId: astral.repeat(512),
      },
    };
    const event = createLifecycleEvent(input, eventId, occurredAt);

    expect(
      parseLifecycleEventEnvelope(JSON.parse(event.payload)),
    ).not.toBeNull();
  });

  it.each([
    ["invoice ID", { objectId: astral.repeat(129), customerId: "customer" }],
    ["customer ID", { objectId: "invoice", customerId: astral.repeat(513) }],
  ])("rejects an over-bound %s at event creation", (_name, values) => {
    expect(() =>
      createLifecycleEvent(
        {
          ...lifecycleInputs[8],
          object: { ...lifecycleInputs[8].object, id: values.objectId },
          data: {
            ...lifecycleInputs[8].data,
            invoiceId: values.objectId,
            customerId: values.customerId,
          },
        },
        eventId,
        occurredAt,
      ),
    ).toThrow(/schema contract/i);
  });

  it.each([
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-4000-7000-000000000001",
  ])("rejects the non-RFC UUID %s", (invalidEventId) => {
    expect(() =>
      createLifecycleEvent(lifecycleInputs[8], invalidEventId, occurredAt),
    ).toThrow(/schema contract/i);
  });
});
