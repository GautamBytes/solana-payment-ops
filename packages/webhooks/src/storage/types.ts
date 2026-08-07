import type {
  LifecycleEventRecord,
  LifecycleEventType,
} from "../domain/types.js";

export type WebhookEndpointState = "active" | "disabled";
export type WebhookDeliveryState =
  "pending" | "in_flight" | "retry_wait" | "succeeded" | "dead";

export interface AddEndpointInput {
  readonly id: string;
  readonly url: string;
  readonly secretEnv: string;
}

export interface WebhookEndpointRecord extends AddEndpointInput {
  readonly previousSecretEnv: string | null;
  readonly state: WebhookEndpointState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaimDueDeliveriesInput {
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
}

export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly leaseToken: string;
  readonly attemptNumber: number;
  readonly firstAttemptAt: Date;
  readonly manualReplay: boolean;
  readonly manualReplayRecovery: boolean;
  readonly endpoint: {
    readonly id: string;
    readonly url: string;
    readonly secretEnv: string;
    readonly previousSecretEnv: string | null;
  };
  readonly event: {
    readonly id: string;
    readonly eventType: LifecycleEventType;
    readonly payload: string;
    readonly digest: string;
    readonly occurredAt: Date;
  };
}

export interface CompleteDeliveryInput {
  readonly deliveryId: string;
  readonly leaseToken: string;
  readonly state: "retry_wait" | "succeeded" | "dead";
  readonly completedAt: Date;
  readonly nextAttemptAt: Date | null;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly durationMs: number;
}

export interface WebhookDeliveryAttemptRecord {
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly outcome: "succeeded" | "retry_wait" | "dead" | "abandoned" | null;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
}

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly endpointId: string;
  readonly state: WebhookDeliveryState;
  readonly attemptCount: number;
  readonly firstAttemptAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly attempts: readonly WebhookDeliveryAttemptRecord[];
}

export interface WebhookEventInspection {
  readonly id: string;
  readonly eventType: LifecycleEventType;
  readonly sourceType: LifecycleEventRecord["sourceType"];
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly payload: string;
  readonly digest: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly deliveries: readonly WebhookDeliveryRecord[];
}

export class WebhookStorageError extends Error {
  public constructor(
    readonly code:
      | "endpoint_conflict"
      | "endpoint_not_found"
      | "event_digest_mismatch"
      | "event_payload_invalid"
      | "event_payload_conflict"
      | "invalid_storage_input",
    message: string,
  ) {
    super(message);
    this.name = "WebhookStorageError";
  }
}
