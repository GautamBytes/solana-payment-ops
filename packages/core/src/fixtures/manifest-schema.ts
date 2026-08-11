import { z } from "zod";
import { EXCEPTION_CODES } from "@payops/contracts";
import type { VerificationCode } from "../domain/types.js";

export const FIXTURE_TAGS = [
  "legacy",
  "versioned",
  "address_lookup_table",
  "outer_instruction",
  "inner_instruction",
  "transfer",
  "transfer_checked",
  "multi_transfer",
  "multi_reference",
  "negative",
  "provisional",
  "reversion",
  "malformed",
  "unicode",
  "token_2022",
] as const;

export const VERIFICATION_CODES = [
  "transaction_success",
  "cluster",
  "commitment",
  "token_program",
  "mint",
  "destination",
  "destination_owner",
  "destination_token_program",
  "destination_balance_mint",
  "amount",
  "decimals",
  "reference",
  "unambiguous_reference_accounts",
  "non_self_transfer",
  "destination_balance_delta",
] as const satisfies readonly VerificationCode[];

const countSchema = z.number().int().nonnegative().max(10_000);
const caseIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const fixtureFileSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\\]+\.json$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalTimestampSchema = z.string().refine(
  (value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  },
  { message: "Timestamp must be canonical UTC ISO-8601" },
);

const verificationExpectationSchema = z
  .strictObject({
    outcome: z.enum(["pass", "verification_failure"]),
    eventCount: countSchema,
    verifiedCount: countSchema,
    eventIds: z.array(z.string().min(1).max(512)).max(10_000),
    verificationCodes: z.array(z.enum(VERIFICATION_CODES)).max(100),
    exceptionCode: z.enum(EXCEPTION_CODES).nullable(),
  })
  .superRefine((expected, context) => {
    if (expected.verifiedCount > expected.eventCount) {
      context.addIssue({
        code: "custom",
        path: ["verifiedCount"],
        message: "Verified count cannot exceed parsed count",
      });
    }
    if (expected.eventIds.length !== expected.eventCount) {
      context.addIssue({
        code: "custom",
        path: ["eventIds"],
        message: "Event ID count must equal parsed count",
      });
    }
    if ((expected.outcome === "pass") !== (expected.verifiedCount === 1)) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Passing verification requires exactly one verified event",
      });
    }
    uniqueValues(expected.eventIds, context, ["eventIds"]);
    uniqueValues(expected.verificationCodes, context, ["verificationCodes"]);
  });

const parseFailureExpectationSchema = z.strictObject({
  outcome: z.literal("parse_failure"),
  eventCount: z.literal(0),
  verifiedCount: z.literal(0),
  eventIds: z.array(z.never()).max(0),
  verificationCodes: z.array(z.never()).max(0),
  exceptionCode: z.null(),
  parseFailureCode: z.enum([
    "invalid_fixture",
    "unsupported_transfer_evidence",
  ]),
});

export const FixtureManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("0.1"),
    generatedAt: canonicalTimestampSchema,
    cases: z
      .array(
        z.strictObject({
          id: caseIdSchema,
          file: fixtureFileSchema,
          sha256: digestSchema,
          kind: z.enum(["payment", "finality_scenario", "schema_rejection"]),
          tags: z.array(z.enum(FIXTURE_TAGS)).min(1).max(FIXTURE_TAGS.length),
          expected: z.discriminatedUnion("outcome", [
            verificationExpectationSchema,
            parseFailureExpectationSchema,
          ]),
        }),
      )
      .min(1)
      .max(256),
  })
  .superRefine((manifest, context) => {
    uniqueValues(
      manifest.cases.map(({ id }) => id),
      context,
      ["cases"],
    );
    uniqueValues(
      manifest.cases.map(({ file }) => file),
      context,
      ["cases"],
    );
    manifest.cases.forEach((item, index) => {
      uniqueValues(item.tags, context, ["cases", index, "tags"]);
    });
  });

export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;
export type FixtureManifestCase = FixtureManifest["cases"][number];
export type FixtureExpectation = FixtureManifestCase["expected"];

function uniqueValues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "Values must be unique",
    });
  }
}
