import { address } from "@solana/kit";
import bs58 from "bs58";
import { z } from "zod";
import { EXCEPTION_CODES } from "../exception-taxonomy.js";
import { unicodeCodePointLength } from "../unicode-length.js";

const MAX_U64 = 18_446_744_073_709_551_615n;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decimalPattern = /^(0|[1-9][0-9]{0,77})$/;
const digestPattern = /^[0-9a-f]{64}$/;
const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{1,128}$/;
const solanaAddressPattern = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";
const solanaSignaturePattern = "^[1-9A-HJ-NP-Za-km-z]{64,88}$";
const canonicalTimestampPattern =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

export function boundedStringSchema(maximum: number) {
  return z
    .string()
    .refine((value) => {
      const length = unicodeCodePointLength(value);
      return length >= 1 && length <= maximum;
    })
    .meta({ minLength: 1, maxLength: maximum });
}

export const publicIdSchema = boundedStringSchema(128);
export const customerIdSchema = boundedStringSchema(512);
export const canonicalUuidSchema = z.string().regex(uuidPattern);
export const canonicalTimestampSchema = z
  .string()
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  })
  .meta({ format: "date-time", pattern: canonicalTimestampPattern });
export const safePositiveIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
export const instructionIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const decimalStringSchema = z
  .string()
  .regex(decimalPattern)
  .meta({ maxLength: 78 });
export const splBaseUnitsSchema = decimalStringSchema
  .refine((value) => {
    try {
      return BigInt(value) <= MAX_U64;
    } catch {
      return false;
    }
  })
  .meta({ maxLength: 20 });
export const solanaAddressSchema = z
  .string()
  .refine((value) => {
    try {
      address(value);
      return true;
    } catch {
      return false;
    }
  })
  .meta({ pattern: solanaAddressPattern, minLength: 32, maxLength: 44 });
export const solanaSignatureSchema = z
  .string()
  .regex(base58Pattern)
  .refine((value) => {
    try {
      return bs58.decode(value).length === 64;
    } catch {
      return false;
    }
  })
  .meta({
    pattern: solanaSignaturePattern,
    minLength: 64,
    maxLength: 88,
  });

const invoiceIssuedDataSchema = z.strictObject({
  invoiceId: publicIdSchema,
  customerId: customerIdSchema,
  publicReference: publicIdSchema,
  currency: z.enum(["USD", "EUR", "GBP", "INR"]),
  totalMinorUnits: decimalStringSchema,
  dueAt: canonicalTimestampSchema,
  issuedAt: canonicalTimestampSchema,
  acceptedAssetSymbols: z
    .array(z.enum(["USDC", "USDT"]))
    .min(1)
    .max(2)
    .refine((values) => new Set(values).size === values.length)
    .meta({ uniqueItems: true }),
});
const invoiceCancelledDataSchema = z.strictObject({
  invoiceId: publicIdSchema,
  publicReference: publicIdSchema,
  previousState: z.enum(["draft", "issued"]),
  reasonCode: z.enum([
    "customer_request",
    "duplicate_invoice",
    "commercial_terms_changed",
    "merchant_error",
    "other_reviewed",
  ]),
  actorKind: z.enum(["member", "api_key"]),
  cancelledAt: canonicalTimestampSchema,
});
const paymentObservedData = {
  paymentAttemptId: publicIdSchema,
  invoiceId: publicIdSchema,
  eventId: publicIdSchema,
  signature: solanaSignatureSchema,
  outerInstructionIndex: instructionIndexSchema,
  innerInstructionIndex: instructionIndexSchema.nullable(),
  mint: solanaAddressSchema,
  amountBaseUnits: splBaseUnitsSchema,
};
const paymentConfirmationRevokedDataSchema = z.strictObject({
  paymentAttemptId: publicIdSchema,
  invoiceId: publicIdSchema,
  eventId: publicIdSchema,
  signature: solanaSignatureSchema,
  previousState: z.enum(["detected", "confirmed"]),
  currentState: z.enum(["failed", "reverted", "quarantined"]),
  code: publicIdSchema,
});
const paymentExceptionCreatedDataSchema = z.strictObject({
  exceptionId: publicIdSchema,
  invoiceId: publicIdSchema.nullable(),
  eventId: publicIdSchema,
  signature: solanaSignatureSchema,
  outerInstructionIndex: instructionIndexSchema,
  innerInstructionIndex: instructionIndexSchema.nullable(),
  amountBaseUnits: splBaseUnitsSchema,
  code: z.enum(EXCEPTION_CODES),
  ruleVersion: publicIdSchema,
  reviewState: z.enum(["open", "resolved", "ignored"]),
});
const invoiceBalanceData = {
  invoiceId: publicIdSchema,
  customerId: customerIdSchema,
  eventId: publicIdSchema,
  allocatedBaseUnits: splBaseUnitsSchema,
  outstandingBaseUnits: splBaseUnitsSchema,
  mint: solanaAddressSchema,
  ruleVersion: publicIdSchema,
};
const invoicePaidDataSchema = z.strictObject({
  invoiceId: publicIdSchema,
  customerId: customerIdSchema,
  eventId: publicIdSchema,
  signature: solanaSignatureSchema,
  outerInstructionIndex: instructionIndexSchema,
  innerInstructionIndex: instructionIndexSchema.nullable(),
  mint: solanaAddressSchema,
  amountBaseUnits: splBaseUnitsSchema,
  ruleCode: publicIdSchema,
  ruleVersion: publicIdSchema,
});
const refundPreparedDataSchema = z.strictObject({
  refundId: publicIdSchema,
  invoiceId: publicIdSchema,
  allocationId: publicIdSchema,
  mint: solanaAddressSchema,
  amountBaseUnits: splBaseUnitsSchema,
  returnOwner: solanaAddressSchema,
  approvalState: z.enum(["pending", "approved"]),
});
const refundFinalizedDataSchema = z.strictObject({
  refundId: publicIdSchema,
  invoiceId: publicIdSchema,
  signature: solanaSignatureSchema,
  eventId: publicIdSchema,
  mint: solanaAddressSchema,
  amountBaseUnits: splBaseUnitsSchema,
});
const evidenceReadyDataSchema = z.strictObject({
  evidencePackId: publicIdSchema,
  invoiceId: publicIdSchema,
  manifestDigest: z.string().regex(digestPattern),
  signingKeyId: publicIdSchema,
  resourceId: publicIdSchema,
});

function objectSchema<Type extends string>(type: Type) {
  return z.strictObject({
    type: z.literal(type),
    id: publicIdSchema,
    version: safePositiveIntegerSchema,
  });
}

function eventSchema<
  EventType extends string,
  ObjectType extends string,
  DataSchema extends z.ZodType,
>(type: EventType, objectType: ObjectType, data: DataSchema) {
  return z.strictObject({
    schemaVersion: z.literal("0.1"),
    id: canonicalUuidSchema,
    type: z.literal(type),
    occurredAt: canonicalTimestampSchema,
    statusAtOccurrence: publicIdSchema,
    object: objectSchema(objectType),
    data,
  });
}

export const lifecycleEventEnvelopeSchema = z.discriminatedUnion("type", [
  eventSchema("invoice.issued", "invoice", invoiceIssuedDataSchema),
  eventSchema("invoice.cancelled", "invoice", invoiceCancelledDataSchema),
  eventSchema(
    "payment.detected",
    "payment",
    z.strictObject({
      ...paymentObservedData,
      commitment: z.literal("detected"),
    }),
  ),
  eventSchema(
    "payment.confirmed",
    "payment",
    z.strictObject({
      ...paymentObservedData,
      commitment: z.literal("confirmed"),
    }),
  ),
  eventSchema(
    "payment.finalized",
    "payment",
    z.strictObject({
      ...paymentObservedData,
      commitment: z.literal("finalized"),
    }),
  ),
  eventSchema(
    "payment.confirmation_revoked",
    "payment",
    paymentConfirmationRevokedDataSchema,
  ),
  eventSchema(
    "payment.exception_created",
    "payment_exception",
    paymentExceptionCreatedDataSchema,
  ),
  eventSchema("invoice.partial", "invoice", z.strictObject(invoiceBalanceData)),
  eventSchema("invoice.paid", "invoice", invoicePaidDataSchema),
  eventSchema(
    "invoice.overpaid",
    "invoice",
    z.strictObject({
      ...invoiceBalanceData,
      excessBaseUnits: splBaseUnitsSchema,
    }),
  ),
  eventSchema("refund.prepared", "refund", refundPreparedDataSchema),
  eventSchema("refund.finalized", "refund", refundFinalizedDataSchema),
  eventSchema("evidence.ready", "evidence_pack", evidenceReadyDataSchema),
]);
