import { z } from "zod";
import { EXCEPTION_CODES } from "../exception-taxonomy.js";
import {
  canonicalTimestampSchema,
  canonicalUuidSchema,
  lifecycleEventEnvelopeSchema,
  publicIdSchema,
  solanaAddressSchema,
  solanaSignatureSchema,
  splBaseUnitsSchema,
} from "../lifecycle/schema.js";

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeIntegerStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const commitmentSchema = z.enum(["confirmed", "finalized"]);
const exceptionCodeKeySchema = z
  .string()
  .regex(new RegExp(`^(${EXCEPTION_CODES.join("|")})$`));

const compiledInstructionSchema = z.strictObject({
  programIdIndex: nonNegativeIntegerSchema,
  accounts: z.array(nonNegativeIntegerSchema),
  data: z.string().min(1),
  stackHeight: nonNegativeIntegerSchema.nullable().optional(),
});

const tokenBalanceSchema = z.strictObject({
  accountIndex: nonNegativeIntegerSchema,
  mint: solanaAddressSchema,
  owner: solanaAddressSchema.optional(),
  programId: solanaAddressSchema.optional(),
  uiTokenAmount: z.strictObject({
    amount: nonNegativeIntegerStringSchema,
    decimals: nonNegativeIntegerSchema,
  }),
});

const addressTableLookupSchema = z.strictObject({
  accountKey: solanaAddressSchema,
  writableIndexes: z.array(z.number().int().min(0).max(255)),
  readonlyIndexes: z.array(z.number().int().min(0).max(255)),
});

const transactionMessageSchema = z.strictObject({
  header: z.strictObject({
    numRequiredSignatures: nonNegativeIntegerSchema,
    numReadonlySignedAccounts: nonNegativeIntegerSchema,
    numReadonlyUnsignedAccounts: nonNegativeIntegerSchema,
  }),
  accountKeys: z.array(solanaAddressSchema),
  addressTableLookups: z.array(addressTableLookupSchema),
  instructions: z.array(compiledInstructionSchema),
  recentBlockhash: solanaAddressSchema,
});

const transactionMetaSchema = z.strictObject({
  err: z.union([
    z.null(),
    z.string().min(1),
    z.record(z.string(), z.unknown()),
  ]),
  loadedAddresses: z
    .strictObject({
      writable: z.array(solanaAddressSchema),
      readonly: z.array(solanaAddressSchema),
    })
    .optional(),
  innerInstructions: z
    .array(
      z.strictObject({
        index: nonNegativeIntegerSchema,
        instructions: z.array(compiledInstructionSchema),
      }),
    )
    .nullable()
    .optional(),
  preTokenBalances: z.array(tokenBalanceSchema),
  postTokenBalances: z.array(tokenBalanceSchema),
});

export const paymentFixtureArtifactSchema = z.strictObject({
  fixtureVersion: z.literal("0.1"),
  name: z.string().min(1).max(256),
  expectation: z.strictObject({
    cluster: z.literal("mainnet-beta"),
    recipientOwner: solanaAddressSchema,
    destinationTokenAccount: solanaAddressSchema,
    mint: solanaAddressSchema,
    tokenProgram: solanaAddressSchema,
    amountBaseUnits: splBaseUnitsSchema,
    decimals: z.number().int().min(0).max(255),
    reference: solanaAddressSchema,
    requiredCommitment: commitmentSchema,
  }),
  rpcTransaction: z.strictObject({
    cluster: z.enum(["mainnet-beta", "devnet", "localnet"]),
    commitment: commitmentSchema,
    signature: solanaSignatureSchema,
    slot: nonNegativeIntegerSchema,
    blockTime: z.number().int().nullable(),
    version: z.union([z.literal("legacy"), z.literal(0)]),
    transaction: z.strictObject({
      signatures: z.array(solanaSignatureSchema).min(1),
      message: transactionMessageSchema,
    }),
    meta: transactionMetaSchema,
  }),
});

const warningSchema = z.enum([
  "coverage_incomplete",
  "finality_pending",
  "open_retries",
  "open_quarantines",
  "unclassified_finalized_value",
  "audit_busy",
]);

export const auditReportArtifactSchema = z.strictObject({
  schemaVersion: z.literal("0.1"),
  runId: publicIdSchema,
  generatedAt: canonicalTimestampSchema,
  coverage: z.array(
    z.strictObject({
      watchTargetId: publicIdSchema,
      coverage: z.enum(["complete", "incomplete"]),
      capturedHeadSlot: nonNegativeIntegerStringSchema.nullable(),
      committedHeadSlot: nonNegativeIntegerStringSchema.nullable(),
      signatures: nonNegativeIntegerSchema,
      finalized: nonNegativeIntegerSchema,
      pendingFinality: nonNegativeIntegerSchema,
      retriesOpen: nonNegativeIntegerSchema,
      quarantinesOpen: nonNegativeIntegerSchema,
    }),
  ),
  totals: z.strictObject({
    invoices: nonNegativeIntegerSchema,
    finalizedEvents: nonNegativeIntegerSchema,
    exactMatches: nonNegativeIntegerSchema,
    exceptions: nonNegativeIntegerSchema,
    unapplied: nonNegativeIntegerSchema,
  }),
  exceptionsByCode: z.record(exceptionCodeKeySchema, nonNegativeIntegerSchema),
  warnings: z.array(warningSchema),
  rows: z.array(
    z.strictObject({
      invoiceId: publicIdSchema.nullable(),
      customerId: z.string().min(1).max(512).nullable(),
      status: z.enum(["open", "matched", "exception", "unapplied"]),
      expectedMint: solanaAddressSchema,
      amountBaseUnits: splBaseUnitsSchema,
      eventId: publicIdSchema.nullable(),
      ruleCode: z
        .union([z.literal("exact_match"), z.enum(EXCEPTION_CODES)])
        .nullable(),
    }),
  ),
});

export const webhookRequestArtifactSchema = z.strictObject({
  schemaVersion: z.literal("0.1"),
  headers: z.strictObject({
    "content-type": z.literal("application/json"),
    "payops-delivery-id": canonicalUuidSchema,
    "payops-event-id": canonicalUuidSchema,
    "payops-signature": z.string().regex(/^v1=[0-9a-f]{64}$/),
    "payops-timestamp": z.string().regex(/^(0|[1-9][0-9]{0,12})$/),
  }),
  body: lifecycleEventEnvelopeSchema,
});
