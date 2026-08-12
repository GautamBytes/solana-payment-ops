import { generateKeyPairSync, randomUUID } from "node:crypto";
import { generateKeyPairSigner } from "@solana/kit";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import { parseLifecycleEventEnvelope } from "@payops/webhooks";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CheckoutStore,
  AccountingExportService,
  ExceptionStore,
  EvidencePackService,
  InvoiceStore,
  OrganizationDatabase,
  PaymentAttemptService,
  PaymentStatusProjector,
  QuoteExpiryService,
  runPlatformMigrations,
  verifyEvidencePack,
  type StablecoinObservation,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_payment_projection_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const alternateSignature =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

describeDatabase("hosted payment status projection", () => {
  let database: OrganizationDatabase;
  let checkoutStore: CheckoutStore;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await checkoutStore?.close();
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
    database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    checkoutStore = new CheckoutStore(database, databaseUrl!);
  });

  afterAll(async () => {
    await checkoutStore?.close();
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("projects detected, confirmed, finalized, and paid exactly once", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "detected", "999901");
    const projector = new PaymentStatusProjector(database);

    await expect(project(projector)).resolves.toMatchObject({
      outcome: "changed",
      publicStatus: "detected",
    });
    await setChainState(database, "confirmed");
    await expect(project(projector)).resolves.toMatchObject({
      publicStatus: "confirmed",
    });
    await setChainState(database, "finalized");
    await expect(project(projector)).resolves.toMatchObject({
      publicStatus: "paid",
    });
    await expect(project(projector)).resolves.toEqual({ outcome: "not_found" });

    const checkout = await checkoutStore.getActiveForInvoice({
      organizationId,
      actorId: "merchant",
      invoiceId: fixture.invoiceId,
    });
    expect(checkout).not.toBeNull();
    const publicView = await checkoutStore.publicView(
      checkout!,
      new Date("2026-08-12T12:05:00.000Z"),
    );
    expect(publicView).toMatchObject({
      schemaVersion: "0.1",
      invoice: { publicReference: "INV-PROJECTION", status: "paid" },
      currentAttempt: {
        publicAttemptId: fixture.attempt.publicAttemptId,
        status: "paid",
      },
    });
    expect(JSON.stringify(publicView)).not.toContain(organizationId);
    expect(JSON.stringify(publicView)).not.toContain(fixture.invoiceId);

    await expect(
      new InvoiceStore(database).cancel({
        organizationId,
        actorKind: "api_key",
        actorId: "merchant",
        invoiceId: fixture.invoiceId,
        reasonCode: "customer_request",
        now: new Date("2026-08-12T12:06:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invoice_has_payment" });

    const evidence = await inspect(database);
    expect(evidence.projection).toEqual({ public_status: "paid", version: 5 });
    expect(evidence.invoice).toEqual({ status: "paid", version: 3 });
    expect(evidence.allocations).toBe(1);
    expect(evidence.exceptions).toBe(0);
    expect(evidence.journals).toEqual([
      {
        source_type: "invoice_issued",
        source_id: fixture.invoiceId,
        debit: "100",
        credit: "100",
      },
      {
        source_type: "payment_received",
        source_id: "hosted-event-1",
        debit: "100",
        credit: "100",
      },
    ]);
    expect(evidence.history).toEqual([
      "awaiting_payment",
      "detected",
      "confirmed",
      "finalized",
      "paid",
    ]);
    expect(evidence.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "payment.detected",
        "payment.confirmed",
        "payment.finalized",
        "invoice.paid",
      ]),
    );
    for (const event of evidence.events) {
      expect(
        parseLifecycleEventEnvelope(JSON.parse(event.payload) as unknown),
      ).not.toBeNull();
      expect(event.payload).not.toContain("customer@example.com");
      expect(event.payload).not.toContain("checkout-token");
    }
  });

  it("creates a durable exception instead of paying a wrong amount", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999900");
    const result = await project(new PaymentStatusProjector(database));
    expect(result).toMatchObject({ publicStatus: "exception" });

    const evidence = await inspect(database);
    expect(evidence.invoice.status).toBe("issued");
    expect(evidence.allocations).toBe(0);
    expect(evidence.exceptions).toBe(1);
    expect(evidence.journals).toEqual([
      {
        source_type: "invoice_issued",
        source_id: fixture.invoiceId,
        debit: "100",
        credit: "100",
      },
      {
        source_type: "unapplied_receipt",
        source_id: "hosted-event-1",
        debit: "100",
        credit: "100",
      },
    ]);
    expect(evidence.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "payment.finalized",
        "payment.exception_created",
      ]),
    );
    expect(
      JSON.parse(
        evidence.events.find(
          (event) => event.type === "payment.exception_created",
        )!.payload,
      ) as { data: { code: string } },
    ).toMatchObject({ data: { code: "partial_payment" } });
  });

  it("does not recognize merchant cash for a wrong-destination transfer", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999901");
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          UPDATE normalized_transfers
          SET destination_token_account = ${"2".repeat(32)}
        `;
      },
    );
    await project(new PaymentStatusProjector(database));
    const evidence = await inspect(database);
    expect(evidence.exceptions).toBe(1);
    expect(evidence.journals).toEqual([
      {
        source_type: "invoice_issued",
        source_id: fixture.invoiceId,
        debit: "100",
        credit: "100",
      },
    ]);
  });

  it("reports the actual transferred asset for a wrong-asset exception", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "1000000");
    const actualMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          UPDATE normalized_transfers SET mint = ${actualMint}, decimals = 6
        `;
      },
    );
    await project(new PaymentStatusProjector(database));
    const [exception] = await new ExceptionStore(database).list({
      organizationId,
      actorId: "merchant-operator",
      limit: 10,
      state: "open",
    });
    expect(exception).toMatchObject({
      assetSymbol: "USDT",
      mint: actualMint,
      decimals: 6,
      ruleCode: "wrong_asset",
    });
    for (const statement of [
      (sql: Parameters<Parameters<typeof database.transaction>[1]>[0]) => sql`
        UPDATE hosted_payment_exceptions
        SET asset_symbol = NULL
        WHERE id = ${exception!.id}
      `,
      (sql: Parameters<Parameters<typeof database.transaction>[1]>[0]) => sql`
        UPDATE hosted_payment_exceptions
        SET mint = ${"2".repeat(32)}, asset_symbol = NULL
        WHERE id = ${exception!.id}
      `,
      (sql: Parameters<Parameters<typeof database.transaction>[1]>[0]) => sql`
        UPDATE hosted_payment_exceptions
        SET decimals = 9
        WHERE id = ${exception!.id}
      `,
    ]) {
      await expect(
        database.transaction(
          { organizationId, actorId: "merchant-operator" },
          statement,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("assigns and resolves an exception with optimistic locking and append-only history", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999900");
    await project(new PaymentStatusProjector(database));
    const store = new ExceptionStore(database);
    const [created] = await store.list({
      organizationId,
      actorId: "merchant-operator",
      limit: 10,
      state: "open",
    });
    expect(created).toMatchObject({
      invoiceId: fixture.invoiceId,
      assetSymbol: "USDC",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      ruleCode: "partial_payment",
      reviewState: "open",
      version: 1,
    });

    const assigned = await store.assign({
      organizationId,
      actorKind: "session",
      actorId: "merchant-operator",
      exceptionId: created!.id,
      assignee: "finance@example.com",
      expectedVersion: 1,
      note: "Review against the customer remittance.",
      now: new Date("2026-08-12T12:06:00.000Z"),
    });
    expect(assigned).toMatchObject({
      reviewState: "assigned",
      assignedTo: "finance@example.com",
      version: 2,
    });
    await expect(
      store.resolve({
        organizationId,
        actorKind: "session",
        actorId: "merchant-operator",
        exceptionId: created!.id,
        resolutionCode: "leave_unapplied",
        note: "Receipt retained as unapplied cash pending customer instruction.",
        expectedVersion: 1,
        now: new Date("2026-08-12T12:07:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "exception_version_conflict" });
    const investigating = await store.startInvestigation({
      organizationId,
      actorKind: "session",
      actorId: "merchant-operator",
      exceptionId: created!.id,
      reasonCode: "operator_review",
      expectedVersion: 2,
      now: new Date("2026-08-12T12:07:00.000Z"),
    });
    expect(investigating).toMatchObject({
      reviewState: "investigating",
      version: 3,
    });
    const escalated = await store.escalate({
      organizationId,
      actorKind: "session",
      actorId: "merchant-operator",
      exceptionId: created!.id,
      reasonCode: "specialist_review",
      expectedVersion: 3,
      now: new Date("2026-08-12T12:08:00.000Z"),
    });
    expect(escalated).toMatchObject({ reviewState: "escalated", version: 4 });
    await expect(
      store.startInvestigation({
        organizationId,
        actorKind: "session",
        actorId: "merchant-operator",
        exceptionId: created!.id,
        reasonCode: "operator_review",
        expectedVersion: 4,
        now: new Date("2026-08-12T12:08:30.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_exception_transition" });
    const reassigned = await store.assign({
      organizationId,
      actorKind: "session",
      actorId: "merchant-operator",
      exceptionId: created!.id,
      assignee: "specialist@example.com",
      expectedVersion: 4,
      now: new Date("2026-08-12T12:08:45.000Z"),
    });
    expect(reassigned).toMatchObject({
      reviewState: "escalated",
      assignedTo: "specialist@example.com",
      version: 5,
    });
    const resolved = await store.resolve({
      organizationId,
      actorKind: "session",
      actorId: "merchant-operator",
      exceptionId: created!.id,
      resolutionCode: "leave_unapplied",
      note: "Receipt retained as unapplied cash pending customer instruction.",
      expectedVersion: 5,
      now: new Date("2026-08-12T12:09:00.000Z"),
    });
    expect(resolved).toMatchObject({
      reviewState: "resolved",
      resolutionCode: "leave_unapplied",
      resolvedBy: "merchant-operator",
      version: 6,
    });
    await expect(
      store.assign({
        organizationId,
        actorKind: "session",
        actorId: "merchant-operator",
        exceptionId: created!.id,
        assignee: "other@example.com",
        expectedVersion: 6,
        now: new Date("2026-08-12T12:10:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "exception_closed" });
    const reopened = await store.reopen({
      organizationId,
      actorKind: "session",
      actorId: "merchant-operator",
      exceptionId: created!.id,
      reasonCode: "new_evidence",
      note: "Customer supplied additional remittance evidence.",
      expectedVersion: 6,
      now: new Date("2026-08-12T12:11:00.000Z"),
    });
    expect(reopened).toMatchObject({
      reviewState: "open",
      assignedTo: null,
      resolutionCode: null,
      resolvedBy: null,
      version: 7,
    });
    await expect(
      store.history({
        organizationId,
        actorId: "merchant-operator",
        exceptionId: created!.id,
      }),
    ).resolves.toMatchObject([
      {
        sequence: 1,
        eventType: "assigned",
        fromState: "open",
        toState: "assigned",
      },
      {
        sequence: 2,
        eventType: "investigation_started",
        fromState: "assigned",
        toState: "investigating",
      },
      {
        sequence: 3,
        eventType: "escalated",
        fromState: "investigating",
        toState: "escalated",
      },
      {
        sequence: 4,
        eventType: "assigned",
        fromState: "escalated",
        toState: "escalated",
      },
      {
        sequence: 5,
        eventType: "resolved",
        fromState: "escalated",
        toState: "resolved",
      },
      {
        sequence: 6,
        eventType: "reopened",
        fromState: "resolved",
        toState: "open",
      },
    ]);
  });

  it("rolls back an exception update when idempotency completion fails", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999900");
    await project(new PaymentStatusProjector(database));
    const store = new ExceptionStore(database);
    const [created] = await store.list({
      organizationId,
      actorId: "merchant-operator",
      limit: 10,
      state: "open",
    });
    await expect(
      store.assign({
        organizationId,
        actorKind: "session",
        actorId: "merchant-operator",
        exceptionId: created!.id,
        assignee: "finance@example.com",
        expectedVersion: 1,
        now: new Date("2026-08-12T12:06:00.000Z"),
        idempotency: {
          complete: async () => {
            throw new Error("forced idempotency failure");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "exception_store_unavailable" });
    await expect(
      store.list({
        organizationId,
        actorId: "merchant-operator",
        limit: 10,
        state: "open",
      }),
    ).resolves.toEqual([expect.objectContaining({ version: 1 })]);
    await expect(
      store.history({
        organizationId,
        actorId: "merchant-operator",
        exceptionId: created!.id,
      }),
    ).resolves.toEqual([]);
  });

  it("generates immutable canonical JSON and human-readable signed evidence", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999901");
    await project(new PaymentStatusProjector(database));
    const keyPair = generateKeyPairSync("ed25519");
    const privateKeyPem = keyPair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const publicKeyPem = keyPair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const service = new EvidencePackService(database, {
      signingKeyId: "evidence-key-2026-08",
      privateKeyPem,
    });
    const pack = await service.generate({
      organizationId,
      actorKind: "session",
      actorId: "merchant-accountant",
      invoiceId: fixture.invoiceId,
      now: new Date("2026-08-12T12:10:00.000Z"),
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(pack.manifestBytes),
    ) as {
      schemaVersion: string;
      invoice: { id: string; publicReference: string };
      chainEvents: unknown[];
      allocations: unknown[];
      journals: unknown[];
      webhooks: {
        events: unknown[];
        eventCount: number;
        deliveryCount: number;
        attemptCount: number;
      };
    };
    expect(manifest).toMatchObject({
      schemaVersion: "0.1",
      invoice: { id: fixture.invoiceId, publicReference: "INV-PROJECTION" },
      chainEvents: [
        expect.objectContaining({
          eventId: "hosted-event-1",
          cluster: "mainnet-beta",
          transaction: expect.objectContaining({
            digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            rawBodyIncluded: false,
          }),
          observation: expect.objectContaining({ slot: "123456" }),
          lifecycle: expect.objectContaining({
            finalizedAt: expect.any(String),
          }),
        }),
      ],
      allocations: [expect.objectContaining({ ruleCode: "exact_match" })],
      webhooks: { eventCount: 2, deliveryCount: 0, attemptCount: 0 },
    });
    expect(manifest.journals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: "invoice_issued" }),
        expect.objectContaining({ sourceType: "payment_received" }),
      ]),
    );
    expect(new TextDecoder().decode(pack.pdfBytes).startsWith("%PDF-1.4")).toBe(
      true,
    );
    expect(verifyEvidencePack(pack, publicKeyPem)).toBe(true);
    const tampered = {
      ...pack,
      manifestBytes: new TextEncoder().encode(
        new TextDecoder()
          .decode(pack.manifestBytes)
          .replace("INV-PROJECTION", "INV-TAMPERED"),
      ),
    };
    expect(verifyEvidencePack(tampered, publicKeyPem)).toBe(false);
    expect(
      verifyEvidencePack(
        { ...pack, pdfBytes: new TextEncoder().encode("tampered pdf") },
        publicKeyPem,
      ),
    ).toBe(false);
    await expect(inspect(database)).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: "evidence.ready" }),
      ]),
    });
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) =>
          sql`UPDATE evidence_packs SET signing_key_id = 'tampered'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("includes chain provenance for an exception-only payment", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999900");
    await project(new PaymentStatusProjector(database));
    const keyPair = generateKeyPairSync("ed25519");
    const service = new EvidencePackService(database, {
      signingKeyId: "evidence-key-2026-08",
      privateKeyPem: keyPair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    });
    const pack = await service.generate({
      organizationId,
      actorKind: "session",
      actorId: "merchant-accountant",
      invoiceId: fixture.invoiceId,
      now: new Date("2026-08-12T12:10:00.000Z"),
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(pack.manifestBytes),
    ) as {
      chainEvents: { eventId: string; currentState: string }[];
      allocations: unknown[];
      exceptions: { ruleCode: string }[];
    };
    expect(manifest.chainEvents).toEqual([
      expect.objectContaining({
        eventId: "hosted-event-1",
        currentState: "finalized",
      }),
    ]);
    expect(manifest.allocations).toEqual([]);
    expect(manifest.exceptions).toEqual([
      expect.objectContaining({ ruleCode: "partial_payment" }),
    ]);
  });

  it("exports payment attempts separately from allocation rows", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999901");
    await project(new PaymentStatusProjector(database));
    const service = new AccountingExportService(database);
    const common = {
      organizationId,
      actorKind: "session" as const,
      actorId: "merchant-accountant",
      fromTime: new Date("2026-08-12T00:00:00.000Z"),
      throughTime: new Date("2026-08-13T00:00:00.000Z"),
      now: new Date("2026-08-13T00:01:00.000Z"),
    };
    const payments = await service.generate({
      ...common,
      format: "payments_csv",
    });
    const allocations = await service.generate({
      ...common,
      format: "allocations_csv",
    });
    const paymentCsv = new TextDecoder().decode(payments.contentBytes);
    const allocationCsv = new TextDecoder().decode(allocations.contentBytes);
    expect(paymentCsv).toContain("Payment Attempt ID,Public Payment ID");
    expect(paymentCsv).toContain(fixture.attempt.publicAttemptId);
    expect(allocationCsv).toContain("Allocation ID,Invoice ID");
    expect(paymentCsv).not.toBe(allocationCsv);
  });

  it("rolls back evidence, audit, and outbox when idempotency completion fails", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999901");
    await project(new PaymentStatusProjector(database));
    const keyPair = generateKeyPairSync("ed25519");
    const service = new EvidencePackService(database, {
      signingKeyId: "evidence-key-2026-08",
      privateKeyPem: keyPair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    });
    await expect(
      service.generate({
        organizationId,
        actorKind: "session",
        actorId: "merchant-accountant",
        invoiceId: fixture.invoiceId,
        now: new Date("2026-08-12T12:10:00.000Z"),
        auditRequestId: randomUUID(),
        idempotency: {
          status: 201,
          responseBody: (pack) => ({ id: pack.id }),
          committer: {
            complete: async () => {
              throw new Error("forced idempotency failure");
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "evidence_store_unavailable" });
    await expect(
      database.transaction({ organizationId, actorId: "test" }, async (sql) => {
        const [row] = await sql<
          { packs: number; events: number; audits: number }[]
        >`
            SELECT
              (SELECT count(*) FROM evidence_packs)::integer AS packs,
              (SELECT count(*) FROM webhook_events
                WHERE event_type = 'evidence.ready')::integer AS events,
              (SELECT count(*) FROM audit_events
                WHERE action = 'evidence.generate')::integer AS audits
          `;
        return row;
      }),
    ).resolves.toEqual({ packs: 0, events: 0, audits: 0 });
  });

  it("fails closed when a transfer carries extra references", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999901");
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO event_references (chain_event_id, reference_address)
          SELECT id, 'attacker-added-reference' FROM chain_events
          WHERE event_id = 'hosted-event-1'
        `;
      },
    );
    await project(new PaymentStatusProjector(database));
    const evidence = await inspect(database);
    expect(evidence.invoice.status).toBe("issued");
    expect(evidence.allocations).toBe(0);
    expect(evidence.exceptions).toBe(1);
    expect(
      JSON.parse(
        evidence.events.find(
          (event) => event.type === "payment.exception_created",
        )!.payload,
      ) as { data: { code: string; invoiceId: string | null } },
    ).toMatchObject({
      data: { code: "ambiguous_reference", invoiceId: null },
    });
  });

  it("revokes only non-final confirmation and keeps the attempt reusable", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "confirmed", "999901");
    const projector = new PaymentStatusProjector(database);
    await project(projector);
    await setChainState(database, "detected");
    await expect(project(projector)).resolves.toEqual({ outcome: "unchanged" });
    await setChainState(database, "reverted");
    await expect(project(projector)).resolves.toMatchObject({
      publicStatus: "confirmation_revoked",
    });
    await expect(project(projector)).resolves.toEqual({ outcome: "unchanged" });

    const evidence = await inspect(database);
    expect(evidence.history).toEqual([
      "awaiting_payment",
      "confirmed",
      "confirmation_revoked",
    ]);
    expect(evidence.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "payment.confirmed",
        "payment.confirmation_revoked",
      ]),
    );
  });

  it("does not let an unchanged early event starve a later status transition", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "detected", "999901", {
      eventId: "a-stable-event",
      signature: "1".repeat(64),
    });
    const projector = new PaymentStatusProjector(database);
    await projector.projectOne({
      organizationId,
      actorId: "status-worker",
      chainEventId: "a-stable-event",
      now: new Date("2026-08-12T12:04:00.000Z"),
    });
    await seedChainEvent(database, fixture, "confirmed", "999901", {
      eventId: "z-actionable-event",
      signature: alternateSignature,
    });

    await expect(
      projector.projectAvailable({
        organizationId,
        actorId: "status-worker",
        now: new Date("2026-08-12T12:05:00.000Z"),
        limit: 1,
      }),
    ).resolves.toEqual({ examined: 1, changed: 1 });
    await expect(inspect(database)).resolves.toMatchObject({
      projection: { public_status: "confirmed" },
    });
  });

  it("rolls the status transition back when transactional outbox enqueue fails", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "detected", "999901");
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql.unsafe(`
          CREATE FUNCTION payops_test_fail_webhook() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$;
          CREATE TRIGGER payops_test_fail_webhook
          BEFORE INSERT ON webhook_events
          FOR EACH ROW EXECUTE FUNCTION payops_test_fail_webhook();
        `);
      },
    );
    await expect(project(new PaymentStatusProjector(database))).rejects.toThrow(
      "forced outbox failure",
    );
    const evidence = await inspect(database);
    expect(evidence.projection).toEqual({
      public_status: "awaiting_payment",
      version: 1,
    });
    expect(evidence.history).toEqual(["awaiting_payment"]);
    expect(evidence.events).toEqual([]);
  });

  it("expires an unpaid quote while retaining its reference for late-payment review", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    const expiry = new QuoteExpiryService(database);
    await expect(
      expiry.expireAvailable({
        organizationId,
        actorId: "expiry-worker",
        now: new Date("2026-08-12T12:15:00.000Z"),
      }),
    ).resolves.toEqual({ expired: 1 });
    await expect(
      expiry.expireAvailable({
        organizationId,
        actorId: "expiry-worker",
        now: new Date("2026-08-12T12:16:00.000Z"),
      }),
    ).resolves.toEqual({ expired: 0 });
    const retained = await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        const [row] = await sql<
          {
            status: string;
            expectation_active: boolean;
            watch_active: boolean;
          }[]
        >`
          SELECT projection.public_status AS status,
            expectation.active AS expectation_active, watch.active AS watch_active
          FROM payment_projections AS projection
          JOIN hosted_payment_expectations AS expectation
            ON expectation.attempt_id = projection.attempt_id
            AND expectation.organization_id = projection.organization_id
          JOIN watch_targets AS watch
            ON watch.organization_id = expectation.organization_id
            AND watch.address = expectation.reference_address
          WHERE projection.organization_id = ${organizationId}::uuid
        `;
        return row!;
      },
    );
    expect(retained).toEqual({
      status: "expired",
      expectation_active: true,
      watch_active: true,
    });
    expect(fixture.attempt.reference).toBeTruthy();
  });
});

async function project(projector: PaymentStatusProjector) {
  return projector.projectOne({
    organizationId,
    actorId: "status-worker",
    chainEventId: "hosted-event-1",
    now: new Date("2026-08-12T12:05:00.000Z"),
  });
}

async function seedAttempt(
  database: OrganizationDatabase,
  checkoutStore: CheckoutStore,
) {
  const customerId = randomUUID();
  const walletId = randomUUID();
  const invoiceId = randomUUID();
  const checkoutId = randomUUID();
  const wallet = await generateKeyPairSigner();
  const tokenAccount = await generateKeyPairSigner();
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      await sql`
        INSERT INTO rpc_providers (
          id, cluster, endpoint_env, endpoint_label, active, created_at
        ) VALUES (
          'provider-mainnet', 'mainnet-beta', 'TEST_RPC_URL', 'test', true, now()
        )
      `;
      await sql`
        INSERT INTO customers (
          id, organization_id, display_name, email, metadata, created_at, updated_at
        ) VALUES (
          ${customerId}::uuid, ${organizationId}::uuid, 'Buyer',
          'customer@example.com', '{}', now(), now()
        )
      `;
      await sql`
        INSERT INTO merchant_wallets (
          id, organization_id, address, cluster, status, verified_at,
          created_at, updated_at
        ) VALUES (
          ${walletId}::uuid, ${organizationId}::uuid, ${wallet.address},
          'mainnet-beta', 'active', now(), now(), now()
        )
      `;
      await sql`
        INSERT INTO merchant_wallet_assets (
          organization_id, wallet_id, symbol, mint, token_account, decimals,
          token_program, created_at
        ) VALUES (
          ${organizationId}::uuid, ${walletId}::uuid, 'USDC',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', ${tokenAccount.address},
          6, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', now()
        )
      `;
      await sql`
        INSERT INTO watch_targets (
          id, provider_id, cluster, address, cutover_slot, overlap_slots,
          committed_head_slot, coverage, active, created_at, organization_id
        ) VALUES (
          ${`merchant-wallet:${walletId}:USDC`}, 'provider-mainnet',
          'mainnet-beta', ${tokenAccount.address}, 123456, 64, 123456,
          'complete', true, now(), ${organizationId}::uuid
        )
      `;
      await sql`
        INSERT INTO merchant_invoices (
          id, organization_id, public_reference, customer_id,
          settlement_wallet_id, accepted_asset_symbols, currency, status,
          subtotal_minor_units, tax_minor_units, total_minor_units, due_at,
          version, issued_at, created_at, updated_at
        ) VALUES (
          ${invoiceId}::uuid, ${organizationId}::uuid, 'INV-PROJECTION',
          ${customerId}::uuid, ${walletId}::uuid, ARRAY['USDC']::text[], 'USD',
          'issued', 100, 0, 100, '2026-08-20T00:00:00.000Z', 2,
          '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z'
        )
      `;
    },
  );
  await checkoutStore.create({
    organizationId,
    actorId: "merchant",
    invoiceId,
    checkoutId,
    publicNonce: Buffer.alloc(32, 1),
    derivationKeyId: "key-v1",
    tokenDigest: "a".repeat(64),
    now: new Date("2026-08-12T00:00:00.000Z"),
  });
  const attempt = await new PaymentAttemptService({
    database,
    providerId: "provider-mainnet",
    environment: "production",
    stablecoinPrices: { observe: async () => stablecoinObservation() },
    quoteHead: {
      getFinalizedHead: async () => ({ slot: 123_456n, signature: null }),
    },
  }).create({
    organizationId,
    actorId: "checkout-payer",
    checkoutId,
    assetSymbol: "USDC",
    idempotencyKey: "projector-attempt-0000000000000001",
    now: new Date("2026-08-12T12:00:00.000Z"),
    signal: new AbortController().signal,
  });
  return {
    invoiceId,
    checkoutId,
    tokenAccount: String(tokenAccount.address),
    attempt,
  };
}

async function seedChainEvent(
  database: OrganizationDatabase,
  fixture: Awaited<ReturnType<typeof seedAttempt>>,
  state: "detected" | "confirmed" | "finalized",
  amountBaseUnits: string,
  identity: {
    readonly eventId: string;
    readonly signature: string;
  } = { eventId: "hosted-event-1", signature: "1".repeat(64) },
) {
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      const raw = await sql<{ id: string }[]>`
        INSERT INTO raw_transactions (
          provider_id, signature, commitment, digest, canonical_body, body,
          byte_length, retrieved_at
        ) VALUES (
          'provider-mainnet', ${identity.signature}, 'confirmed',
          ${identity.signature === "1".repeat(64) ? "d".repeat(64) : "e".repeat(64)},
          '{"blockTime":1786536030}', '{"blockTime":1786536030}'::jsonb,
          24, '2026-08-12T12:00:30.000Z'
        ) RETURNING id::text
      `;
      const event = await sql<{ id: string }[]>`
        INSERT INTO chain_events (
          event_id, cluster, signature, outer_instruction_index,
          inner_instruction_index, raw_transaction_id, current_state
        ) VALUES (
          ${identity.eventId}, 'mainnet-beta', ${identity.signature}, 2, -1,
          ${raw[0]!.id}::bigint, ${state}
        ) RETURNING id::text
      `;
      await sql`
        INSERT INTO discovered_signatures (
          watch_target_id, provider_id, signature, slot, block_time,
          confirmation_status, representation_class, raw_transaction_id,
          parse_digest, finality_state, observed_at
        )
        SELECT target.id, 'provider-mainnet', ${identity.signature}, 123456,
          1786536030, ${state === "finalized" ? "finalized" : "confirmed"},
          'parsed', ${raw[0]!.id}::bigint,
          ${identity.signature === "1".repeat(64) ? "f".repeat(64) : "a".repeat(64)},
          ${state}, '2026-08-12T12:00:31.000Z'
        FROM watch_targets AS target
        WHERE target.address = ${fixture.tokenAccount}
      `;
      await sql`
        INSERT INTO normalized_transfers (
          chain_event_id, parser_version, program_id, source_token_account,
          source_account_index, mint, destination_token_account,
          destination_account_index, authority, amount_base_units, decimals
        ) VALUES (
          ${event[0]!.id}::bigint, '1.0.0',
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          ${fixture.tokenAccount}, 1,
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          ${fixture.tokenAccount}, 2, ${fixture.tokenAccount},
          ${amountBaseUnits}, 6
        )
      `;
      await sql`
        INSERT INTO event_references (chain_event_id, reference_address)
        VALUES (${event[0]!.id}::bigint, ${fixture.attempt.reference})
      `;
    },
  );
}

async function setChainState(database: OrganizationDatabase, state: string) {
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      await sql`
        UPDATE chain_events SET current_state = ${state}
        WHERE event_id = 'hosted-event-1'
      `;
    },
  );
}

async function inspect(database: OrganizationDatabase) {
  return database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      const [projection] = await sql<
        { public_status: string; version: number }[]
      >`SELECT public_status, version FROM payment_projections`;
      const [invoice] = await sql<{ status: string; version: number }[]>`
        SELECT status, version FROM merchant_invoices
      `;
      const history = await sql<{ to_status: string }[]>`
        SELECT to_status FROM payment_status_history ORDER BY source_version
      `;
      const events = await sql<{ type: string; payload: string }[]>`
        SELECT event_type AS type, payload FROM webhook_events ORDER BY created_at, id
      `;
      const [allocationCount] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM hosted_payment_allocations
      `;
      const [exceptionCount] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM hosted_payment_exceptions
      `;
      const journals = await sql<
        {
          source_type: string;
          source_id: string;
          debit: string;
          credit: string;
        }[]
      >`
        SELECT entry.source_type, entry.source_id,
          sum(line.debit_minor_units)::text AS debit,
          sum(line.credit_minor_units)::text AS credit
        FROM journal_entries AS entry
        JOIN journal_lines AS line
          ON line.organization_id = entry.organization_id
          AND line.journal_entry_id = entry.id
        GROUP BY entry.id
        ORDER BY entry.created_at, entry.id
      `;
      return {
        projection: projection!,
        invoice: invoice!,
        history: history.map((row) => row.to_status),
        events,
        allocations: allocationCount!.count,
        exceptions: exceptionCount!.count,
        journals,
      };
    },
  );
}

function stablecoinObservation(): StablecoinObservation {
  return {
    source: "pyth_hermes",
    symbol: "USDC",
    price: "1.0001",
    confidence: "0.0001",
    exponent: -8,
    publishTime: "2026-08-12T11:59:45.000Z",
    feedId: "b".repeat(64),
    receivedAt: "2026-08-12T12:00:00.000Z",
    rawResponseDigest: "c".repeat(64),
  };
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
