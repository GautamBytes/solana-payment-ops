import {
  SUPPORTED_LIFECYCLE_EVENT_TYPES,
  type LifecycleEvent,
  type LifecycleEventType,
  type LifecycleObjectType,
} from "./types.js";
import { unicodeCodePointLength } from "./unicode-length.js";

const eventObjectTypes = {
  "invoice.issued": "invoice",
  "payment.detected": "payment",
  "payment.confirmed": "payment",
  "payment.finalized": "payment",
  "payment.confirmation_revoked": "payment",
  "payment.exception_created": "payment_exception",
  "invoice.partial": "invoice",
  "invoice.paid": "invoice",
  "invoice.overpaid": "invoice",
  "refund.prepared": "refund",
  "refund.finalized": "refund",
  "evidence.ready": "evidence_pack",
} as const satisfies Record<LifecycleEventType, LifecycleObjectType>;
const supportedEventTypes = new Set<string>(SUPPORTED_LIFECYCLE_EVENT_TYPES);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimalPattern = /^(0|[1-9][0-9]{0,77})$/;
const envelopeKeys = [
  "data",
  "id",
  "object",
  "occurredAt",
  "schemaVersion",
  "statusAtOccurrence",
  "type",
] as const;
const objectKeys = ["id", "type", "version"] as const;
const invoiceDataKeys = [
  "amountBaseUnits",
  "customerId",
  "eventId",
  "innerInstructionIndex",
  "invoiceId",
  "mint",
  "outerInstructionIndex",
  "ruleCode",
  "ruleVersion",
  "signature",
] as const;
const exceptionDataKeys = [
  "amountBaseUnits",
  "code",
  "eventId",
  "exceptionId",
  "innerInstructionIndex",
  "invoiceId",
  "outerInstructionIndex",
  "reviewState",
  "ruleVersion",
  "signature",
] as const;

export type LifecycleEventEnvelope = LifecycleEvent & {
  readonly schemaVersion: "0.1";
  readonly id: string;
  readonly occurredAt: string;
};

export function parseLifecycleEventEnvelope(
  value: unknown,
): LifecycleEventEnvelope | null {
  if (!recordWithExactKeys(value, envelopeKeys)) return null;
  const eventType = value.type;
  if (
    value.schemaVersion !== "0.1" ||
    !isUuid(value.id) ||
    !isLifecycleEventType(eventType) ||
    !isCanonicalTimestamp(value.occurredAt) ||
    !boundedString(value.statusAtOccurrence, 128) ||
    !recordWithExactKeys(value.object, objectKeys) ||
    !boundedString(value.object.id, 128) ||
    !positiveInteger(value.object.version) ||
    value.object.type !== eventObjectTypes[eventType]
  ) {
    return null;
  }

  if (eventType === "invoice.paid") {
    if (!invoiceData(value.data) || value.object.id !== value.data.invoiceId) {
      return null;
    }
  } else if (eventType === "payment.exception_created") {
    if (
      !exceptionData(value.data) ||
      value.object.id !== value.data.exceptionId
    ) {
      return null;
    }
  } else if (!genericData(value.data)) {
    return null;
  }
  return value as unknown as LifecycleEventEnvelope;
}

function isLifecycleEventType(value: unknown): value is LifecycleEventType {
  return typeof value === "string" && supportedEventTypes.has(value);
}

function invoiceData(value: unknown): value is Record<string, unknown> {
  return (
    recordWithExactKeys(value, invoiceDataKeys) &&
    boundedString(value.invoiceId, 128) &&
    boundedString(value.customerId, 512) &&
    boundedString(value.eventId, 512) &&
    boundedString(value.signature, 512) &&
    boundedString(value.mint, 128) &&
    boundedString(value.ruleCode, 128) &&
    boundedString(value.ruleVersion, 128) &&
    decimalString(value.amountBaseUnits) &&
    nonNegativeInteger(value.outerInstructionIndex) &&
    nullableNonNegativeInteger(value.innerInstructionIndex)
  );
}

function exceptionData(value: unknown): value is Record<string, unknown> {
  return (
    recordWithExactKeys(value, exceptionDataKeys) &&
    boundedString(value.exceptionId, 128) &&
    (value.invoiceId === null || boundedString(value.invoiceId, 128)) &&
    boundedString(value.eventId, 512) &&
    boundedString(value.signature, 512) &&
    boundedString(value.code, 128) &&
    boundedString(value.ruleVersion, 128) &&
    decimalString(value.amountBaseUnits) &&
    nonNegativeInteger(value.outerInstructionIndex) &&
    nullableNonNegativeInteger(value.innerInstructionIndex) &&
    (value.reviewState === "open" ||
      value.reviewState === "resolved" ||
      value.reviewState === "ignored")
  );
}

function genericData(value: unknown): value is Record<string, never> {
  return recordWithExactKeys(value, [] as const);
}

function recordWithExactKeys<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): value is Record<Keys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && keys.every((key, i) => actual[i] === key)
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  if (typeof value !== "string") return false;
  const length = unicodeCodePointLength(value);
  return length >= 1 && length <= maximum;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function positiveInteger(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 2_147_483_647
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 2_147_483_647
  );
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || nonNegativeInteger(value);
}

function decimalString(value: unknown): value is string {
  return typeof value === "string" && decimalPattern.test(value);
}
