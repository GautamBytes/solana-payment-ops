import { createHash } from "node:crypto";
import { stringifyCanonical } from "@payops/core";
import type { Sql } from "postgres";
import { parseLifecycleEventEnvelope } from "../domain/parse-envelope.js";
import type { LifecycleEventRecord } from "../domain/types.js";
import { WebhookStorageError } from "./types.js";

interface StoredEventRow {
  readonly id: string;
  readonly payload: string;
  readonly payload_digest: string;
}

export async function enqueueLifecycleEvent(
  sql: Sql,
  event: LifecycleEventRecord,
  createdAt: Date,
): Promise<string> {
  const computedDigest = createHash("sha256")
    .update(event.payload, "utf8")
    .digest("hex");
  if (computedDigest !== event.digest) {
    throw new WebhookStorageError(
      "event_digest_mismatch",
      "Lifecycle event digest does not match its payload",
    );
  }
  assertCanonicalEnvelopeMatchesRecord(event);

  await sql`
    INSERT INTO webhook_events (
      id, event_type, source_type, source_id, source_version,
      payload, payload_digest, occurred_at, created_at
    ) VALUES (
      ${event.id}, ${event.eventType}, ${event.sourceType}, ${event.sourceId},
      ${event.sourceVersion}, ${event.payload}, ${event.digest},
      ${event.occurredAt.toISOString()}, ${createdAt.toISOString()}
    )
    ON CONFLICT DO NOTHING
  `;

  const existing = await sql<StoredEventRow[]>`
    SELECT id::text, payload, payload_digest
    FROM webhook_events
    WHERE event_type = ${event.eventType}
      AND source_type = ${event.sourceType}
      AND source_id = ${event.sourceId}
      AND source_version = ${event.sourceVersion}
  `;
  const stored = existing[0];
  if (
    stored === undefined ||
    stored.payload_digest !== event.digest ||
    stored.payload !== event.payload
  ) {
    throw new WebhookStorageError(
      "event_payload_conflict",
      "Lifecycle event source already has a different immutable payload",
    );
  }

  await sql`
    INSERT INTO webhook_deliveries (
      endpoint_id, event_id, state, next_attempt_at, created_at, updated_at
    )
    SELECT id, ${stored.id}, 'pending', ${createdAt.toISOString()},
      ${createdAt.toISOString()}, ${createdAt.toISOString()}
    FROM webhook_endpoints
    WHERE state = 'active'
    ON CONFLICT (endpoint_id, event_id) DO NOTHING
  `;
  return stored.id;
}

function assertCanonicalEnvelopeMatchesRecord(
  event: LifecycleEventRecord,
): void {
  let value: unknown;
  try {
    value = JSON.parse(event.payload) as unknown;
  } catch {
    throw invalidPayload("Lifecycle event payload is not a JSON envelope");
  }
  if (stringifyCanonical(value) !== event.payload) {
    throw invalidPayload(
      "Lifecycle event payload must use canonical JSON bytes",
    );
  }
  const envelope = parseLifecycleEventEnvelope(value);
  if (envelope === null) {
    throw invalidPayload(
      "Lifecycle event payload has an invalid envelope schema",
    );
  }

  let occurredAt: string;
  try {
    occurredAt = event.occurredAt.toISOString();
  } catch {
    throw invalidPayload(
      "Lifecycle event metadata does not match its canonical payload",
    );
  }
  if (
    event.id !== envelope.id ||
    event.eventType !== envelope.type ||
    event.sourceType !== envelope.object.type ||
    event.sourceId !== envelope.object.id ||
    event.sourceVersion !== envelope.object.version ||
    occurredAt !== envelope.occurredAt
  ) {
    throw invalidPayload(
      "Lifecycle event metadata does not match its canonical payload",
    );
  }
}

function invalidPayload(message: string): WebhookStorageError {
  return new WebhookStorageError("event_payload_invalid", message);
}
