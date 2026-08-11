import { createHash, randomUUID } from "node:crypto";
import type { OrganizationTransaction } from "../db/organization-transaction.js";

const safeCodePattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const objectIdPattern = /^[\x21-\x7e]{1,128}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AuditEventInput {
  readonly organizationId: string;
  readonly actorKind: "session" | "api_key" | "system";
  readonly actorId: string;
  readonly action: string;
  readonly objectKind: string;
  readonly objectId: string;
  readonly requestId: string;
  readonly ipAddress?: string;
  readonly ipDigestSecret?: string;
  readonly outcome: "succeeded" | "rejected" | "failed";
  readonly reasonCode: string;
  readonly occurredAt: Date;
}

export class AuditError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Audit operation failed");
    this.name = "AuditError";
    this.code = code;
  }
}

export async function appendAuditEvent(
  transaction: OrganizationTransaction,
  input: AuditEventInput,
): Promise<string> {
  validate(input);
  const id = randomUUID();
  const ipDigest =
    input.ipAddress === undefined
      ? null
      : createHash("sha256")
          .update(`${input.ipDigestSecret ?? ""}\0${input.ipAddress}`, "utf8")
          .digest("hex");
  await transaction`
    INSERT INTO audit_events (
      id, organization_id, actor_kind, actor_id, action, object_kind,
      object_id, request_id, ip_digest, outcome, reason_code, occurred_at
    ) VALUES (
      ${id}::uuid, ${input.organizationId}::uuid, ${input.actorKind},
      ${input.actorId}, ${input.action}, ${input.objectKind}, ${input.objectId},
      ${input.requestId}::uuid, ${ipDigest}, ${input.outcome},
      ${input.reasonCode}, ${input.occurredAt.toISOString()}
    )
  `;
  return id;
}

function validate(input: AuditEventInput): void {
  if (
    !uuidPattern.test(input.organizationId) ||
    !uuidPattern.test(input.requestId) ||
    !objectIdPattern.test(input.actorId) ||
    !objectIdPattern.test(input.objectId) ||
    !safeCodePattern.test(input.action) ||
    !safeCodePattern.test(input.objectKind) ||
    !safeCodePattern.test(input.reasonCode) ||
    !Number.isFinite(input.occurredAt.getTime()) ||
    (input.ipAddress !== undefined &&
      (input.ipDigestSecret === undefined || input.ipDigestSecret.length < 32))
  ) {
    throw new AuditError("invalid_audit_event");
  }
}
