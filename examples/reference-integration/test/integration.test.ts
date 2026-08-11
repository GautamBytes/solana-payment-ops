import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { signWebhook } from "@payops/webhooks";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createReferenceWebhookReceiver,
  migrateReferenceReceiver,
  verifyIntentFromFixture,
} from "../src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/cases/usdc-transfer-checked-v0-finalized.json",
    import.meta.url,
  ),
);
const confirmedFixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/cases/confirmed-provisional-payment.json",
    import.meta.url,
  ),
);
const now = new Date("2026-08-11T12:00:00.000Z");
const timestamp = String(Math.floor(now.getTime() / 1_000));
const secret = "reference-integration-secret";
const eventId = "00000000-0000-4000-8000-000000000006";
const body = `{"schemaVersion":"0.1","id":"${eventId}","type":"invoice.paid","occurredAt":"2026-08-11T12:00:00.000Z","statusAtOccurrence":"matched","object":{"type":"invoice","id":"invoice-001","version":1},"data":{"invoiceId":"invoice-001","customerId":"customer-001","eventId":"chain-event-001","signature":"2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T","outerInstructionIndex":0,"innerInstructionIndex":null,"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amountBaseUnits":"12500000","ruleCode":"exact_match","ruleVersion":"0.1"}}`;

const sql = postgres(databaseUrl, { max: 1 });

beforeAll(async () => {
  await migrateReferenceReceiver(databaseUrl);
  await migrateReferenceReceiver(databaseUrl);
});

beforeEach(async () => {
  await sql`TRUNCATE reference_paid_invoices, reference_processed_events`;
});

afterAll(async () => {
  await sql.end();
});

describe("external PayOps integration", () => {
  it("maps an application payment intent to exact finalized verification", async () => {
    const report = await verifyIntentFromFixture(
      {
        id: "intent-001",
        recipientOwner: "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym",
        destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountBaseUnits: "12500000",
        reference: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
      },
      fixturePath,
    );

    expect(report.verified).toBe(true);
    expect(report.checks.every(({ passed }) => passed)).toBe(true);
  });

  it("verifies raw bytes and commits one side effect across concurrent retries", async () => {
    const receiver = createReferenceWebhookReceiver({
      databaseUrl,
      secrets: [secret],
      now: () => now,
    });
    const request = {
      rawBody: body,
      eventId,
      timestamp,
      signature: signWebhook(body, timestamp, secret),
    };

    try {
      await expect(
        Promise.all([receiver.handle(request), receiver.handle(request)]),
      ).resolves.toEqual([{ status: 204 }, { status: 204 }]);
      const [counts] = await sql<
        { readonly events: number; readonly effects: number }[]
      >`
        SELECT
          (SELECT count(*)::int FROM reference_processed_events) AS events,
          (SELECT count(*)::int FROM reference_paid_invoices) AS effects
      `;
      expect(counts).toEqual({ events: 1, effects: 1 });
    } finally {
      await receiver.close();
    }
  });

  it("rejects tampering before JSON parsing or database effects", async () => {
    const receiver = createReferenceWebhookReceiver({
      databaseUrl,
      secrets: [secret],
      now: () => now,
    });
    const tampered = `${body} `;

    try {
      await expect(
        receiver.handle({
          rawBody: tampered,
          eventId,
          timestamp,
          signature: signWebhook(body, timestamp, secret),
        }),
      ).resolves.toEqual({ status: 400 });
      const [counts] = await sql<
        { readonly events: number; readonly effects: number }[]
      >`
        SELECT
          (SELECT count(*)::int FROM reference_processed_events) AS events,
          (SELECT count(*)::int FROM reference_paid_invoices) AS effects
      `;
      expect(counts).toEqual({ events: 0, effects: 0 });
    } finally {
      await receiver.close();
    }
  });

  it("does not trust the fixture's embedded expectation over the intent", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(fixture.expectation.amountBaseUnits).toBe("12500000");

    const report = await verifyIntentFromFixture(
      {
        id: "intent-002",
        recipientOwner: fixture.expectation.recipientOwner,
        destinationTokenAccount: fixture.expectation.destinationTokenAccount,
        mint: fixture.expectation.mint,
        amountBaseUnits: "12500001",
        reference: fixture.expectation.reference,
      },
      fixturePath,
    );

    expect(report.verified).toBe(false);
    expect(report.checks.find(({ code }) => code === "amount")?.passed).toBe(
      false,
    );
  });

  it("never promotes a confirmed observation to finalized payment", async () => {
    const report = await verifyIntentFromFixture(
      {
        id: "intent-003",
        recipientOwner: "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym",
        destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountBaseUnits: "12500000",
        reference: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
      },
      confirmedFixturePath,
    );

    expect(report.verified).toBe(false);
    expect(
      report.checks.find(({ code }) => code === "commitment"),
    ).toMatchObject({
      passed: false,
      expected: "finalized",
      actual: "confirmed",
    });
  });
});
