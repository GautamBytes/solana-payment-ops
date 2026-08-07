import { createHash } from "node:crypto";
import { stringifyCanonical } from "@payops/core";
import type {
  LifecycleEvent,
  LifecycleEventRecord,
  LifecycleEventType,
} from "./types.js";
import { parseLifecycleEventEnvelope } from "./parse-envelope.js";

const supportedEventTypes = new Set<LifecycleEventType>([
  "invoice.paid",
  "payment.exception_created",
]);

export function createLifecycleEvent(
  input: LifecycleEvent,
  eventId: string,
  occurredAt: Date,
): LifecycleEventRecord {
  if (!supportedEventTypes.has(input.type)) {
    throw new Error("Unsupported lifecycle event type: " + input.type);
  }

  const envelope = {
    schemaVersion: "0.1",
    id: eventId,
    type: input.type,
    occurredAt: occurredAt.toISOString(),
    object: input.object,
    data: input.data,
  };
  if (parseLifecycleEventEnvelope(envelope) === null) {
    throw new TypeError("Lifecycle event does not satisfy the schema contract");
  }
  const payload = stringifyCanonical(envelope);

  return {
    id: eventId,
    eventType: input.type,
    sourceType: input.object.type,
    sourceId: input.object.id,
    sourceVersion: input.object.version,
    occurredAt,
    payload,
    digest: createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}
