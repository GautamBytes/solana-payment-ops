import { describe, expect, it, vi } from "vitest";
import { signWebhook } from "../src/signing/hmac.js";
import { createExampleConsumer } from "../src/examples/verify-consumer.js";

const now = new Date("2026-08-07T10:00:00.000Z");
const timestamp = String(Math.floor(now.getTime() / 1_000));
const body =
  '{"schemaVersion":"0.1","id":"123e4567-e89b-42d3-a456-426614174000","type":"invoice.paid","occurredAt":"2026-08-07T10:00:00.000Z","object":{"type":"invoice","id":"invoice-1","version":1},"data":{"invoiceId":"invoice-1","customerId":"customer-1","eventId":"event-1","signature":"signature-1","outerInstructionIndex":0,"innerInstructionIndex":null,"mint":"mint-1","amountBaseUnits":"100","ruleCode":"exact_match","ruleVersion":"0.1"}}';

const exceptionBody =
  '{"schemaVersion":"0.1","id":"223e4567-e89b-42d3-a456-426614174000","type":"payment.exception_created","occurredAt":"2026-08-07T10:00:00.000Z","object":{"type":"payment_exception","id":"exception-1","version":1},"data":{"exceptionId":"exception-1","invoiceId":null,"eventId":"event-1","signature":"signature-1","outerInstructionIndex":0,"innerInstructionIndex":2,"amountBaseUnits":"100","code":"amount_mismatch","ruleVersion":"0.1","reviewState":"open"}}';

function request(secret = "current-secret", rawBody = body) {
  return {
    rawBody,
    eventId: "123e4567-e89b-42d3-a456-426614174000",
    timestamp,
    signature: signWebhook(rawBody, timestamp, secret),
  };
}

describe("consumer verification example", () => {
  it("verifies exact raw bytes before parsing and applies a valid event", async () => {
    const apply = vi.fn(async () => undefined);
    const parse = vi.fn(JSON.parse);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      previousSecret: "previous-secret",
      now: () => now,
      apply,
      parse,
    });
    await expect(consumer.handle(request())).resolves.toEqual({ status: 204 });
    expect(apply).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith(body);
  });

  it("accepts the previous secret during rotation", async () => {
    const apply = vi.fn(async () => undefined);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      previousSecret: "previous-secret",
      now: () => now,
      apply,
    });
    await expect(consumer.handle(request("previous-secret"))).resolves.toEqual({
      status: 204,
    });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("accepts the exact payment exception event variant", async () => {
    const apply = vi.fn(async () => undefined);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => now,
      apply,
    });
    await expect(
      consumer.handle({
        rawBody: exceptionBody,
        eventId: "223e4567-e89b-42d3-a456-426614174000",
        timestamp,
        signature: signWebhook(exceptionBody, timestamp, "current-secret"),
      }),
    ).resolves.toEqual({ status: 204 });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("does not parse or apply a body with an invalid signature", async () => {
    const apply = vi.fn(async () => undefined);
    const parse = vi.fn(JSON.parse);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => now,
      apply,
      parse,
    });
    const invalid = {
      ...request(),
      signature: signWebhook(body + " ", timestamp, "current-secret"),
    };
    await expect(consumer.handle(invalid)).resolves.toEqual({ status: 400 });
    expect(parse).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("enforces the replay window before parsing", async () => {
    const apply = vi.fn(async () => undefined);
    const parse = vi.fn(JSON.parse);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => new Date(now.getTime() + 300_001),
      apply,
      parse,
    });
    await expect(consumer.handle(request())).resolves.toEqual({ status: 400 });
    expect(parse).not.toHaveBeenCalled();
  });

  it("deduplicates by verified event ID and acknowledges a retry", async () => {
    const apply = vi.fn(async () => undefined);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => now,
      apply,
    });
    await consumer.handle(request());
    await expect(consumer.handle(request())).resolves.toEqual({ status: 204 });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("does not run the same side effect concurrently", async () => {
    let release!: () => void;
    const applying = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = vi.fn(() => applying);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => now,
      apply,
    });
    const first = consumer.handle(request());
    const duplicate = consumer.handle(request());
    await Promise.resolve();
    expect(apply).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { status: 204 },
      { status: 204 },
    ]);
  });

  it("rejects malformed JSON and a header/body event ID mismatch", async () => {
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => now,
      apply: vi.fn(async () => undefined),
    });
    await expect(
      consumer.handle(request("current-secret", "not-json")),
    ).resolves.toEqual({ status: 400 });
    await expect(
      consumer.handle({ ...request(), eventId: "different-id" }),
    ).resolves.toEqual({ status: 400 });
  });

  it("returns 500 on a failed side effect and allows the sender to retry", async () => {
    const apply = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => now,
      apply,
    });
    await expect(consumer.handle(request())).resolves.toEqual({ status: 500 });
    await expect(consumer.handle(request())).resolves.toEqual({ status: 204 });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["malformed UUID", { id: "not-a-uuid" }],
    ["unknown event type", { type: "invoice.created" }],
    ["invalid occurredAt", { occurredAt: "yesterday" }],
    [
      "object type mismatch",
      { object: { type: "payment_exception", id: "invoice-1", version: 1 } },
    ],
    [
      "object ID mismatch",
      { object: { type: "invoice", id: "other", version: 1 } },
    ],
    [
      "invalid object version",
      { object: { type: "invoice", id: "invoice-1", version: 0 } },
    ],
    ["missing data field", { data: { invoiceId: "invoice-1" } }],
    [
      "wrong data field type",
      { data: { ...JSON.parse(body).data, amountBaseUnits: 100 } },
    ],
    ["extra envelope key", { unexpected: true }],
    [
      "extra object key",
      {
        object: { type: "invoice", id: "invoice-1", version: 1, extra: true },
      },
    ],
    ["extra data key", { data: { ...JSON.parse(body).data, extra: true } }],
    [
      "unbounded string",
      { data: { ...JSON.parse(body).data, customerId: "x".repeat(513) } },
    ],
  ])("rejects a signed envelope with %s", async (_label, change) => {
    const apply = vi.fn(async () => undefined);
    const consumer = createExampleConsumer({
      currentSecret: "current-secret",
      now: () => now,
      apply,
    });
    const malformed = JSON.stringify({ ...JSON.parse(body), ...change });
    const changedId = (change as { id?: unknown }).id;
    await expect(
      consumer.handle({
        rawBody: malformed,
        eventId: typeof changedId === "string" ? changedId : request().eventId,
        timestamp,
        signature: signWebhook(malformed, timestamp, "current-secret"),
      }),
    ).resolves.toEqual({ status: 400 });
    expect(apply).not.toHaveBeenCalled();
  });
});
