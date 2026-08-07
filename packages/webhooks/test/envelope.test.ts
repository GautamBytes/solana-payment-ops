import { MAINNET_USDC } from "@payops/core";
import { describe, expect, it } from "vitest";
import {
  createLifecycleEvent,
  parseLifecycleEventEnvelope,
  type LifecycleEvent,
} from "../src/index.js";

const occurredAt = new Date("2026-08-07T00:00:00.000Z");
const eventId = "00000000-0000-4000-8000-000000000001";
const astral = "\u{1F680}";

describe("createLifecycleEvent", () => {
  it("creates a canonical invoice.paid envelope with a stable digest", () => {
    const event = createLifecycleEvent(
      {
        type: "invoice.paid",
        object: { type: "invoice", id: "inv-001", version: 1 },
        data: {
          invoiceId: "inv-001",
          customerId: "customer-001",
          eventId: "event-001",
          signature: "signature-001",
          outerInstructionIndex: 0,
          innerInstructionIndex: null,
          mint: MAINNET_USDC.mint,
          amountBaseUnits: "12500000",
          ruleCode: "exact_match",
          ruleVersion: "0.1",
        },
      },
      eventId,
      occurredAt,
    );

    expect(event).toEqual({
      id: eventId,
      eventType: "invoice.paid",
      sourceType: "invoice",
      sourceId: "inv-001",
      sourceVersion: 1,
      occurredAt,
      payload: [
        "{",
        '  "data": {',
        '    "amountBaseUnits": "12500000",',
        '    "customerId": "customer-001",',
        '    "eventId": "event-001",',
        '    "innerInstructionIndex": null,',
        '    "invoiceId": "inv-001",',
        `    "mint": "${MAINNET_USDC.mint}",`,
        '    "outerInstructionIndex": 0,',
        '    "ruleCode": "exact_match",',
        '    "ruleVersion": "0.1",',
        '    "signature": "signature-001"',
        "  },",
        `  "id": "${eventId}",`,
        '  "object": {',
        '    "id": "inv-001",',
        '    "type": "invoice",',
        '    "version": 1',
        "  },",
        '  "occurredAt": "2026-08-07T00:00:00.000Z",',
        '  "schemaVersion": "0.1",',
        '  "type": "invoice.paid"',
        "}",
        "",
      ].join("\n"),
      digest:
        "e84968f95cd3b8c8380b2f69bc74019b00bd37f66dcc312e10f37de27317ddab",
    });
    expect(JSON.parse(event.payload)).toMatchObject({
      schemaVersion: "0.1",
      id: eventId,
      type: "invoice.paid",
    });
  });

  it("preserves numeric instruction coordinates and string base-unit amounts", () => {
    const event = createLifecycleEvent(
      {
        type: "invoice.paid",
        object: { type: "invoice", id: "inv-001", version: 1 },
        data: {
          invoiceId: "inv-001",
          customerId: "customer-001",
          eventId: "event-001",
          signature: "signature-001",
          outerInstructionIndex: 0,
          innerInstructionIndex: 2,
          mint: MAINNET_USDC.mint,
          amountBaseUnits: "12500000",
          ruleCode: "exact_match",
          ruleVersion: "0.1",
        },
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
          object: { type: "invoice", id: "inv-001", version: 1 },
          data: {},
        } as unknown as LifecycleEvent,
        eventId,
        occurredAt,
      ),
    ).toThrow("Unsupported lifecycle event type: invoice.created");
  });

  it.each([
    {
      type: "invoice.paid" as const,
      object: {
        type: "invoice" as const,
        id: astral.repeat(128),
        version: 1,
      },
      data: {
        invoiceId: astral.repeat(128),
        customerId: astral.repeat(512),
        eventId: "event-001",
        signature: "signature-001",
        outerInstructionIndex: 0,
        innerInstructionIndex: null,
        mint: MAINNET_USDC.mint,
        amountBaseUnits: "12500000",
        ruleCode: "exact_match",
        ruleVersion: "0.1",
      },
    },
    {
      type: "payment.exception_created" as const,
      object: {
        type: "payment_exception" as const,
        id: astral.repeat(128),
        version: 1,
      },
      data: {
        exceptionId: astral.repeat(128),
        invoiceId: astral.repeat(128),
        eventId: "event-002",
        signature: "signature-002",
        outerInstructionIndex: 1,
        innerInstructionIndex: 2,
        amountBaseUnits: "1",
        code: "wrong_asset",
        ruleVersion: "0.1",
        reviewState: "open" as const,
      },
    },
  ])(
    "round-trips the $type producer boundary through the consumer",
    (input) => {
      const event = createLifecycleEvent(input, eventId, occurredAt);

      expect(parseLifecycleEventEnvelope(JSON.parse(event.payload))).toEqual(
        JSON.parse(event.payload),
      );
    },
  );

  it.each([
    ["invoice ID", { objectId: astral.repeat(129), customerId: "customer" }],
    ["customer ID", { objectId: "invoice", customerId: astral.repeat(513) }],
  ])("rejects an over-bound %s at event creation", (_name, values) => {
    expect(() =>
      createLifecycleEvent(
        {
          type: "invoice.paid",
          object: { type: "invoice", id: values.objectId, version: 1 },
          data: {
            invoiceId: values.objectId,
            customerId: values.customerId,
            eventId: "event-001",
            signature: "signature-001",
            outerInstructionIndex: 0,
            innerInstructionIndex: null,
            mint: MAINNET_USDC.mint,
            amountBaseUnits: "1",
            ruleCode: "exact_match",
            ruleVersion: "0.1",
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
      createLifecycleEvent(
        {
          type: "invoice.paid",
          object: { type: "invoice", id: "inv-001", version: 1 },
          data: {
            invoiceId: "inv-001",
            customerId: "customer-001",
            eventId: "event-001",
            signature: "signature-001",
            outerInstructionIndex: 0,
            innerInstructionIndex: null,
            mint: MAINNET_USDC.mint,
            amountBaseUnits: "1",
            ruleCode: "exact_match",
            ruleVersion: "0.1",
          },
        },
        invalidEventId,
        occurredAt,
      ),
    ).toThrow(/schema contract/i);
  });
});
