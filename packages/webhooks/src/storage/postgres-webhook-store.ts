import postgres, { type Sql } from "postgres";
import {
  validateEndpointUrl,
  type EndpointPolicy,
} from "../security/endpoint-policy.js";
import type {
  AddEndpointInput,
  ClaimedDelivery,
  ClaimDueDeliveriesInput,
  CompleteDeliveryInput,
  WebhookDeliveryAttemptRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
  WebhookEventInspection,
} from "./types.js";
import { WebhookStorageError } from "./types.js";

const endpointIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const safeErrorCodePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface EndpointRow {
  readonly id: string;
  readonly url: string;
  readonly secret_env: string;
  readonly previous_secret_env: string | null;
  readonly state: "active" | "disabled";
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ClaimRow {
  readonly delivery_id: string;
  readonly lease_token: string;
  readonly attempt_number: number;
  readonly first_attempt_at: Date;
  readonly manual_replay: boolean;
  readonly manual_replay_recovery: boolean;
  readonly endpoint_id: string;
  readonly endpoint_url: string;
  readonly secret_env: string;
  readonly previous_secret_env: string | null;
  readonly event_id: string;
  readonly event_type: ClaimedDelivery["event"]["eventType"];
  readonly payload: string;
  readonly payload_digest: string;
  readonly occurred_at: Date;
}

interface EventRow {
  readonly id: string;
  readonly event_type: WebhookEventInspection["eventType"];
  readonly source_type: WebhookEventInspection["sourceType"];
  readonly source_id: string;
  readonly source_version: number;
  readonly payload: string;
  readonly payload_digest: string;
  readonly occurred_at: Date;
  readonly created_at: Date;
}

interface DeliveryRow {
  readonly id: string;
  readonly endpoint_id: string;
  readonly state: WebhookDeliveryRecord["state"];
  readonly attempt_count: number;
  readonly first_attempt_at: Date | null;
  readonly next_attempt_at: Date | null;
  readonly last_status_code: number | null;
  readonly last_error_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AttemptRow {
  readonly delivery_id: string;
  readonly attempt_number: number;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly outcome: WebhookDeliveryAttemptRecord["outcome"];
  readonly http_status: number | null;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
}

export interface PostgresWebhookStoreConfig {
  readonly databaseUrl: string;
  readonly endpointPolicy?: EndpointPolicy;
}

export class PostgresWebhookStore {
  readonly #sql: Sql;
  readonly #endpointPolicy: EndpointPolicy | undefined;

  public constructor(config: PostgresWebhookStoreConfig) {
    this.#sql = postgres(config.databaseUrl);
    this.#endpointPolicy = config.endpointPolicy;
  }

  public async addEndpoint(
    input: AddEndpointInput,
    createdAt: Date,
  ): Promise<{ readonly inserted: boolean }> {
    assertEndpointId(input.id);
    assertEnvironmentName(input.secretEnv);
    const { url } = validateEndpointUrl(input.url, this.#endpointPolicy);
    const inserted = await this.#sql<{ id: string }[]>`
      INSERT INTO webhook_endpoints (
        id, url, secret_env, state, created_at, updated_at
      ) VALUES (
        ${input.id}, ${url}, ${input.secretEnv}, 'active',
        ${createdAt.toISOString()}, ${createdAt.toISOString()}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    const existing = await this.#sql<EndpointRow[]>`
      SELECT * FROM webhook_endpoints WHERE id = ${input.id}
    `;
    const row = existing[0];
    if (
      row === undefined ||
      row.url !== url ||
      row.secret_env !== input.secretEnv
    ) {
      throw new WebhookStorageError(
        "endpoint_conflict",
        "Endpoint ID already has a different configuration",
      );
    }
    return { inserted: inserted.length === 1 };
  }

  public async rotateEndpointSecret(
    endpointId: string,
    secretEnv: string,
    updatedAt: Date,
  ): Promise<{ readonly rotated: boolean }> {
    assertEndpointId(endpointId);
    assertEnvironmentName(secretEnv);
    const rotated = await this.#sql<{ id: string }[]>`
      UPDATE webhook_endpoints SET
        previous_secret_env = secret_env,
        secret_env = ${secretEnv},
        updated_at = ${updatedAt.toISOString()}
      WHERE id = ${endpointId} AND secret_env <> ${secretEnv}
      RETURNING id
    `;
    if (rotated.length === 1) return { rotated: true };
    const existing = await this.#sql<{ present: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM webhook_endpoints WHERE id = ${endpointId}
      ) AS present
    `;
    if (existing[0]?.present !== true) {
      throw new WebhookStorageError(
        "endpoint_not_found",
        "Webhook endpoint was not found",
      );
    }
    return { rotated: false };
  }

  public async listEndpoints(): Promise<readonly WebhookEndpointRecord[]> {
    const rows = await this.#sql<EndpointRow[]>`
      SELECT * FROM webhook_endpoints ORDER BY id
    `;
    return rows.map(endpointRecord);
  }

  public async claimDueDeliveries(
    input: ClaimDueDeliveriesInput,
  ): Promise<readonly ClaimedDelivery[]> {
    assertPositiveInteger(input.limit, "Claim limit", 256);
    assertPositiveInteger(input.leaseMs, "Lease duration", 3_600_000);
    const now = input.now.toISOString();
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    const rows = await this.#sql.begin(
      (transaction) =>
        transaction<ClaimRow[]>`
        WITH candidates AS MATERIALIZED (
          SELECT delivery.id, delivery.state, delivery.attempt_count,
            (delivery.attempt_count > 0 AND delivery.first_attempt_at IS NULL)
              AS manual_replay,
            (delivery.state = 'in_flight'
              AND delivery.last_error_code = 'manual_replay_in_flight')
              AS manual_replay_recovery
          FROM webhook_deliveries AS delivery
          JOIN webhook_endpoints AS endpoint ON endpoint.id = delivery.endpoint_id
          WHERE endpoint.state = 'active'
            AND (
              (delivery.state IN ('pending', 'retry_wait')
                AND delivery.next_attempt_at <= ${now})
              OR (delivery.state = 'in_flight'
                AND delivery.lease_expires_at <= ${now})
            )
          ORDER BY delivery.next_attempt_at, delivery.created_at, delivery.id
          LIMIT ${input.limit}
          FOR UPDATE OF delivery SKIP LOCKED
        ), abandoned AS (
          UPDATE webhook_delivery_attempts AS attempt SET
            completed_at = ${now},
            outcome = 'abandoned',
            duration_ms = GREATEST(
              0,
              LEAST(
                2147483647,
                floor(extract(epoch FROM (${now}::timestamptz - attempt.started_at)) * 1000)
              )::integer
            )
          FROM candidates
          WHERE candidates.state = 'in_flight'
            AND attempt.delivery_id = candidates.id
            AND attempt.attempt_number = candidates.attempt_count
            AND attempt.completed_at IS NULL
          RETURNING attempt.delivery_id
        ), claimed AS (
          UPDATE webhook_deliveries AS delivery SET
            state = 'in_flight',
            attempt_count = delivery.attempt_count + 1,
            first_attempt_at = COALESCE(delivery.first_attempt_at, ${now}),
            last_error_code = CASE
              WHEN candidates.manual_replay OR candidates.manual_replay_recovery
                THEN 'manual_replay_in_flight'
              ELSE delivery.last_error_code
            END,
            lease_token = gen_random_uuid(),
            lease_expires_at = ${leaseExpiresAt.toISOString()},
            updated_at = ${now}
          FROM candidates
          WHERE delivery.id = candidates.id
            AND (SELECT count(*) FROM abandoned) >= 0
          RETURNING delivery.*
        ), attempts AS (
          INSERT INTO webhook_delivery_attempts (
            delivery_id, attempt_number, started_at
          )
          SELECT id, attempt_count, ${now} FROM claimed
          RETURNING delivery_id, attempt_number
        )
        SELECT
          delivery.id::text AS delivery_id,
          delivery.lease_token::text,
          attempts.attempt_number,
          delivery.first_attempt_at,
          candidates.manual_replay,
          candidates.manual_replay_recovery,
          endpoint.id AS endpoint_id,
          endpoint.url AS endpoint_url,
          endpoint.secret_env,
          endpoint.previous_secret_env,
          event.id::text AS event_id,
          event.event_type,
          event.payload,
          event.payload_digest,
          event.occurred_at
        FROM claimed AS delivery
        JOIN candidates ON candidates.id = delivery.id
        JOIN attempts ON attempts.delivery_id = delivery.id
        JOIN webhook_endpoints AS endpoint ON endpoint.id = delivery.endpoint_id
        JOIN webhook_events AS event ON event.id = delivery.event_id
        ORDER BY delivery.created_at, delivery.id
      `,
    );
    return rows.map(claimedDelivery);
  }

  public async completeDelivery(
    input: CompleteDeliveryInput,
  ): Promise<boolean> {
    assertCompletionInput(input);
    const rows = await this.#sql<{ delivery_id: string }[]>`
      WITH completed_delivery AS (
        UPDATE webhook_deliveries SET
          state = ${input.state},
          next_attempt_at = ${input.nextAttemptAt?.toISOString() ?? null},
          lease_token = NULL,
          lease_expires_at = NULL,
          last_status_code = ${input.httpStatus},
          last_error_code = ${input.errorCode},
          updated_at = ${input.completedAt.toISOString()}
        WHERE id = ${input.deliveryId}
          AND state = 'in_flight'
          AND lease_token = ${input.leaseToken}
        RETURNING id, attempt_count
      )
      UPDATE webhook_delivery_attempts AS attempt SET
        completed_at = ${input.completedAt.toISOString()},
        outcome = ${input.state},
        http_status = ${input.httpStatus},
        error_code = ${input.errorCode},
        duration_ms = ${input.durationMs}
      FROM completed_delivery AS delivery
      WHERE attempt.delivery_id = delivery.id
        AND attempt.attempt_number = delivery.attempt_count
        AND attempt.completed_at IS NULL
      RETURNING attempt.delivery_id::text
    `;
    return rows.length === 1;
  }

  public async replayDelivery(deliveryId: string, now: Date): Promise<boolean> {
    const rows = await this.#sql<{ id: string }[]>`
      UPDATE webhook_deliveries SET
        state = 'pending',
        next_attempt_at = ${now.toISOString()},
        first_attempt_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_status_code = NULL,
        last_error_code = NULL,
        updated_at = ${now.toISOString()}
      WHERE id = ${deliveryId}
        AND state IN ('retry_wait', 'succeeded', 'dead')
      RETURNING id::text
    `;
    return rows.length === 1;
  }

  public async inspectEvent(
    eventId: string,
  ): Promise<WebhookEventInspection | null> {
    const events = await this.#sql<EventRow[]>`
      SELECT id::text, event_type, source_type, source_id, source_version,
        payload, payload_digest, occurred_at, created_at
      FROM webhook_events WHERE id = ${eventId}
    `;
    const event = events[0];
    if (event === undefined) return null;
    const deliveries = await this.#sql<DeliveryRow[]>`
      SELECT id::text, endpoint_id, state, attempt_count, first_attempt_at,
        next_attempt_at, last_status_code, last_error_code, created_at, updated_at
      FROM webhook_deliveries
      WHERE event_id = ${eventId}
      ORDER BY endpoint_id
    `;
    const attempts = await this.#sql<AttemptRow[]>`
      SELECT attempt.delivery_id::text, attempt.attempt_number,
        attempt.started_at, attempt.completed_at, attempt.outcome,
        attempt.http_status, attempt.error_code, attempt.duration_ms
      FROM webhook_delivery_attempts AS attempt
      JOIN webhook_deliveries AS delivery ON delivery.id = attempt.delivery_id
      WHERE delivery.event_id = ${eventId}
      ORDER BY attempt.delivery_id, attempt.attempt_number
    `;
    return {
      id: event.id,
      eventType: event.event_type,
      sourceType: event.source_type,
      sourceId: event.source_id,
      sourceVersion: event.source_version,
      payload: event.payload,
      digest: event.payload_digest,
      occurredAt: event.occurred_at,
      createdAt: event.created_at,
      deliveries: deliveries.map((delivery) =>
        deliveryRecord(
          delivery,
          attempts.filter((attempt) => attempt.delivery_id === delivery.id),
        ),
      ),
    };
  }

  public async close(): Promise<void> {
    await this.#sql.end();
  }
}

function endpointRecord(row: EndpointRow): WebhookEndpointRecord {
  return {
    id: row.id,
    url: row.url,
    secretEnv: row.secret_env,
    previousSecretEnv: row.previous_secret_env,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function claimedDelivery(row: ClaimRow): ClaimedDelivery {
  return {
    deliveryId: row.delivery_id,
    leaseToken: row.lease_token,
    attemptNumber: row.attempt_number,
    firstAttemptAt: row.first_attempt_at,
    manualReplay: row.manual_replay,
    manualReplayRecovery: row.manual_replay_recovery,
    endpoint: {
      id: row.endpoint_id,
      url: row.endpoint_url,
      secretEnv: row.secret_env,
      previousSecretEnv: row.previous_secret_env,
    },
    event: {
      id: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      digest: row.payload_digest,
      occurredAt: row.occurred_at,
    },
  };
}

function deliveryRecord(
  row: DeliveryRow,
  attempts: readonly AttemptRow[],
): WebhookDeliveryRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    state: row.state,
    attemptCount: row.attempt_count,
    firstAttemptAt: row.first_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    lastStatusCode: row.last_status_code,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempts: attempts.map((attempt) => ({
      attemptNumber: attempt.attempt_number,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
      outcome: attempt.outcome,
      httpStatus: attempt.http_status,
      errorCode: attempt.error_code,
      durationMs: attempt.duration_ms,
    })),
  };
}

function assertEndpointId(value: string): void {
  if (!endpointIdPattern.test(value)) {
    throw new WebhookStorageError(
      "invalid_storage_input",
      "Endpoint ID has invalid syntax",
    );
  }
}

function assertEnvironmentName(value: string): void {
  if (!environmentNamePattern.test(value)) {
    throw new WebhookStorageError(
      "invalid_storage_input",
      "Secret environment variable name has invalid syntax",
    );
  }
}

function assertPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new WebhookStorageError(
      "invalid_storage_input",
      `${label} must be an integer from 1 to ${maximum}`,
    );
  }
}

function assertCompletionInput(input: CompleteDeliveryInput): void {
  if (
    !Number.isInteger(input.durationMs) ||
    input.durationMs < 0 ||
    input.durationMs > 2_147_483_647 ||
    (input.httpStatus !== null &&
      (!Number.isInteger(input.httpStatus) ||
        input.httpStatus < 100 ||
        input.httpStatus > 599)) ||
    (input.errorCode !== null && !safeErrorCodePattern.test(input.errorCode)) ||
    (input.state === "retry_wait") !== (input.nextAttemptAt !== null)
  ) {
    throw new WebhookStorageError(
      "invalid_storage_input",
      "Delivery completion has invalid scheduling or result data",
    );
  }
}
