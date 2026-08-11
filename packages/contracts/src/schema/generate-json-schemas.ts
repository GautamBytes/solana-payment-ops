import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toJSONSchema, type ZodType } from "zod";
import { lifecycleEventEnvelopeSchema } from "../lifecycle/schema.js";
import {
  auditReportArtifactSchema,
  paymentFixtureArtifactSchema,
  webhookRequestArtifactSchema,
} from "./artifact-schemas.js";

const repositorySchemaBase =
  "https://raw.githubusercontent.com/GautamBytes/solana-payment-ops/v0.1.0/packages/contracts/schemas";

const schemas = [
  {
    file: "audit-report.v0.1.schema.json",
    title: "PayOps audit report v0.1",
    schema: auditReportArtifactSchema,
  },
  {
    file: "lifecycle-event.v0.1.schema.json",
    title: "PayOps lifecycle event v0.1",
    schema: lifecycleEventEnvelopeSchema,
  },
  {
    file: "payment-fixture.v0.1.schema.json",
    title: "PayOps payment fixture v0.1",
    schema: paymentFixtureArtifactSchema,
  },
  {
    file: "webhook-request.v0.1.schema.json",
    title: "PayOps webhook request v0.1",
    schema: webhookRequestArtifactSchema,
  },
] as const;

export async function writeJsonSchemas(outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    schemas.map(async ({ file, title, schema }) => {
      const generated = toJSONSchema(schema as ZodType, {
        target: "draft-2020-12",
        unrepresentable: "any",
        reused: "ref",
      });
      const document = {
        ...generated,
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `${repositorySchemaBase}/${file}`,
        title,
        "x-payops-version": "0.1",
      };
      await writeFile(
        join(outputDirectory, file),
        JSON.stringify(sortJson(document), null, 2) + "\n",
        "utf8",
      );
    }),
  );
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "~standard")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
