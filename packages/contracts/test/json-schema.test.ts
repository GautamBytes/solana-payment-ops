import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromJSONSchema } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonSchemas } from "../src/index.js";
import {
  lifecycleExamples,
  TEST_EVENT_ID,
  TEST_MINT,
  TEST_OCCURRED_AT,
} from "./support/lifecycle-examples.js";

const schemaFiles = [
  "audit-report.v0.1.schema.json",
  "lifecycle-event.v0.1.schema.json",
  "payment-fixture.v0.1.schema.json",
  "webhook-request.v0.1.schema.json",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("checked-in JSON Schemas", () => {
  it("matches deterministic generator output byte for byte", async () => {
    const outputDirectory = await temporaryDirectory();
    await writeJsonSchemas(outputDirectory);

    for (const file of schemaFiles) {
      const [generated, checkedIn] = await Promise.all([
        readFile(join(outputDirectory, file), "utf8"),
        readFile(new URL(`../schemas/${file}`, import.meta.url), "utf8"),
      ]);
      expect(generated.endsWith("\n")).toBe(true);
      expect(generated).toBe(checkedIn);
    }
  });

  it("publishes stable metadata and 13 discriminated lifecycle branches", async () => {
    const schemas = await generateSchemas();
    const lifecycle = schemas["lifecycle-event.v0.1.schema.json"];

    expect(lifecycle).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://raw.githubusercontent.com/GautamBytes/solana-payment-ops/v0.1.0/packages/contracts/schemas/lifecycle-event.v0.1.schema.json",
      title: "PayOps lifecycle event v0.1",
      "x-payops-version": "0.1",
    });
    expect(lifecycle.oneOf).toHaveLength(13);
    expect(
      (lifecycle.oneOf as JsonObject[]).every(
        (branch) => branch.additionalProperties === false,
      ),
    ).toBe(true);
  });

  it("accepts all lifecycle variants and rejects invalid data for each", async () => {
    const schemas = await generateSchemas();
    const validator = fromJSONSchema(
      schemas["lifecycle-event.v0.1.schema.json"],
    );

    for (const event of lifecycleExamples) {
      expect(validator.safeParse(event).success, event.type).toBe(true);
      expect(
        validator.safeParse({ ...event, data: {} }).success,
        event.type,
      ).toBe(false);
    }
  });

  it("expresses bounded IDs, timestamps, signatures, addresses, and amounts", async () => {
    const schemas = await generateSchemas();
    const validator = fromJSONSchema(
      schemas["lifecycle-event.v0.1.schema.json"],
    );
    const paid = structuredClone(lifecycleExamples[8]);

    expect(
      validator.safeParse({
        ...paid,
        id: "00000000-0000-4000-8000-00000000000A",
      }).success,
    ).toBe(false);
    expect(
      validator.safeParse({
        ...paid,
        occurredAt: TEST_OCCURRED_AT.slice(0, -5) + "Z",
      }).success,
    ).toBe(false);
    expect(
      validator.safeParse({
        ...paid,
        object: { ...paid.object, id: "x".repeat(129) },
      }).success,
    ).toBe(false);
    expect(
      validator.safeParse({
        ...paid,
        data: { ...paid.data, customerId: "x".repeat(513) },
      }).success,
    ).toBe(false);
    expect(
      validator.safeParse({
        ...paid,
        data: { ...paid.data, signature: "not-base58" },
      }).success,
    ).toBe(false);
    expect(
      validator.safeParse({
        ...paid,
        data: { ...paid.data, mint: "not-an-address" },
      }).success,
    ).toBe(false);
    expect(
      validator.safeParse({
        ...paid,
        data: { ...paid.data, amountBaseUnits: "01" },
      }).success,
    ).toBe(false);
  });

  it("validates fixture, audit-report, and webhook-request examples", async () => {
    const schemas = await generateSchemas();
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
    const auditReport = {
      schemaVersion: "0.1",
      runId: "run-001",
      generatedAt: TEST_OCCURRED_AT,
      coverage: [
        {
          watchTargetId: "watch-001",
          coverage: "complete",
          capturedHeadSlot: "100",
          committedHeadSlot: "100",
          signatures: 1,
          finalized: 1,
          pendingFinality: 0,
          retriesOpen: 0,
          quarantinesOpen: 0,
        },
      ],
      totals: {
        invoices: 1,
        finalizedEvents: 1,
        exactMatches: 1,
        exceptions: 0,
        unapplied: 0,
      },
      exceptionsByCode: {},
      warnings: [],
      rows: [
        {
          invoiceId: "invoice-001",
          customerId: "customer-001",
          status: "matched",
          expectedMint: TEST_MINT,
          amountBaseUnits: "12500000",
          eventId: "chain-event-001",
          ruleCode: "exact_match",
        },
      ],
    };
    const webhookRequest = {
      schemaVersion: "0.1",
      headers: {
        "content-type": "application/json",
        "payops-delivery-id": "00000000-0000-4000-8000-000000000002",
        "payops-event-id": TEST_EVENT_ID,
        "payops-signature": `v1=${"a".repeat(64)}`,
        "payops-timestamp": "1786449600",
      },
      body: lifecycleExamples[8],
    };

    const examples = [
      ["payment-fixture.v0.1.schema.json", fixture],
      ["audit-report.v0.1.schema.json", auditReport],
      ["webhook-request.v0.1.schema.json", webhookRequest],
    ] as const;
    for (const [file, example] of examples) {
      const validator = fromJSONSchema(schemas[file]);
      expect(validator.safeParse(example).success, file).toBe(true);
      expect(
        validator.safeParse({ ...(example as JsonObject), unknown: true })
          .success,
        file,
      ).toBe(false);
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "payops-schemas-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function generateSchemas(): Promise<
  Record<(typeof schemaFiles)[number], JsonObject>
> {
  const outputDirectory = await temporaryDirectory();
  await writeJsonSchemas(outputDirectory);
  return Object.fromEntries(
    await Promise.all(
      schemaFiles.map(async (file) => [
        file,
        JSON.parse(
          await readFile(join(outputDirectory, file), "utf8"),
        ) as JsonObject,
      ]),
    ),
  ) as Record<(typeof schemaFiles)[number], JsonObject>;
}

type JsonObject = Record<string, any>;
