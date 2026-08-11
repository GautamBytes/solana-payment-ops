export interface CustomerRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly externalId: string | null;
  readonly displayName: string;
  readonly email: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCustomerInput {
  readonly organizationId: string;
  readonly actorKind: "session" | "api_key";
  readonly actorId: string;
  readonly externalId?: string | null;
  readonly displayName: string;
  readonly email?: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly now: Date;
  readonly auditRequestId?: string;
  readonly idempotency?: IdempotencyResponseCommitter;
}

export class CustomerError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(
      "Customer operation failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "CustomerError";
    this.code = code;
  }
}
import type { IdempotencyResponseCommitter } from "../idempotency/idempotency-store.js";
