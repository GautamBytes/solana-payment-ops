import { createHash, randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LedgerStore,
  AccountingExportService,
  OrganizationDatabase,
  runPlatformMigrations,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_ledger_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const usdtMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

describeDatabase("merchant operational ledger", () => {
  let database: OrganizationDatabase;
  let store: LedgerStore;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
    database = new OrganizationDatabase(databaseUrl!, { max: 4 });
    store = new LedgerStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("posts one balanced immutable journal per exact source and replays it", async () => {
    const walletId = randomUUID();
    await seedWallet(database, walletId);
    await store.ensureDefaultAccounts({
      organizationId,
      actorId: "ledger-worker",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    const input = {
      organizationId,
      actorKind: "system" as const,
      actorId: "ledger-worker",
      sourceType: "payment_received" as const,
      sourceId: "hosted-event-1",
      sourceVersion: 1,
      functionalCurrency: "USD" as const,
      description: "Finalized USDC payment for INV-100",
      occurredAt: new Date("2026-08-12T12:05:00.000Z"),
      lines: [
        {
          accountCode: "CASH_USDC",
          debitMinorUnits: "100",
          creditMinorUnits: "0",
          tokenMint: usdcMint,
          tokenBaseUnits: "1000000",
          walletId,
          chainSlot: "199",
        },
        {
          accountCode: "ACCOUNTS_RECEIVABLE",
          debitMinorUnits: "0",
          creditMinorUnits: "100",
        },
      ],
    };
    const posted = await store.postJournal(input);
    await expect(store.postJournal(input)).resolves.toEqual(posted);
    expect(posted).toMatchObject({
      sourceType: "payment_received",
      sourceId: "hosted-event-1",
      debitMinorUnits: "100",
      creditMinorUnits: "100",
      lineCount: 2,
    });
    await expect(
      store.postJournal({ ...input, description: "Conflicting description" }),
    ).rejects.toMatchObject({ code: "journal_source_conflict" });
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) => sql`UPDATE journal_entries SET description = 'tampered'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) => sql`UPDATE ledger_accounts SET name = 'tampered'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) => sql`DELETE FROM journal_lines`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unbalanced journal before persistence", async () => {
    await store.ensureDefaultAccounts({
      organizationId,
      actorId: "ledger-worker",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    await expect(
      store.postJournal({
        organizationId,
        actorKind: "system",
        actorId: "ledger-worker",
        sourceType: "adjustment",
        sourceId: "broken-entry",
        sourceVersion: 1,
        functionalCurrency: "USD",
        description: "Must not persist",
        occurredAt: new Date("2026-08-12T12:05:00.000Z"),
        lines: [
          {
            accountCode: "ACCOUNTS_RECEIVABLE",
            debitMinorUnits: "100",
            creditMinorUnits: "0",
          },
          {
            accountCode: "UNAPPLIED_CASH",
            debitMinorUnits: "0",
            creditMinorUnits: "99",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "journal_unbalanced" });
    await expect(count(database, "journal_entries")).resolves.toBe(0);
  });

  it("requires complete account-matched provenance for every token cash line", async () => {
    const walletId = randomUUID();
    await seedWallet(database, walletId);
    await store.ensureDefaultAccounts({
      organizationId,
      actorId: "ledger-worker",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    const base = {
      organizationId,
      actorKind: "system" as const,
      actorId: "ledger-worker",
      sourceType: "adjustment" as const,
      sourceVersion: 1,
      functionalCurrency: "USD" as const,
      description: "Token cash provenance boundary",
      occurredAt: new Date("2026-08-12T12:05:00.000Z"),
    };
    const balancingLine = {
      accountCode: "UNAPPLIED_CASH",
      debitMinorUnits: "0",
      creditMinorUnits: "100",
    };
    await expect(
      store.postJournal({
        ...base,
        sourceId: "cash-without-provenance",
        lines: [
          {
            accountCode: "CASH_USDC",
            debitMinorUnits: "100",
            creditMinorUnits: "0",
          },
          balancingLine,
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_token_provenance" });
    await expect(
      store.postJournal({
        ...base,
        sourceId: "cash-with-wrong-mint",
        lines: [
          {
            accountCode: "CASH_USDC",
            debitMinorUnits: "100",
            creditMinorUnits: "0",
            tokenMint: usdtMint,
            tokenBaseUnits: "1000000",
            walletId,
            chainSlot: "200",
          },
          balancingLine,
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_token_provenance" });
    await expect(
      insertRawCashJournal(database, {
        sourceId: "raw-cash-without-provenance",
        walletId,
        tokenMint: null,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertRawCashJournal(database, {
        sourceId: "raw-cash-with-wrong-mint",
        walletId,
        tokenMint: usdtMint,
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("supports repeatable-read organization snapshots", async () => {
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) => {
          const [row] = await sql<{ transaction_isolation: string }[]>`
            SHOW transaction_isolation
          `;
          return row!.transaction_isolation;
        },
        { isolationLevel: "repeatable read" },
      ),
    ).resolves.toBe("repeatable read");
  });

  it("records matched, mismatched, and incomplete wallet reconciliation snapshots", async () => {
    const walletId = randomUUID();
    const otherWalletId = randomUUID();
    await seedWallet(database, walletId);
    await seedWallet(database, otherWalletId, false);
    await store.ensureDefaultAccounts({
      organizationId,
      actorId: "ledger-worker",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    await store.postJournal({
      organizationId,
      actorKind: "system",
      actorId: "ledger-worker",
      sourceType: "unapplied_receipt",
      sourceId: "receipt-1",
      sourceVersion: 1,
      functionalCurrency: "USD",
      description: "Unapplied USDC receipt",
      occurredAt: new Date("2026-08-12T12:05:00.000Z"),
      lines: [
        {
          accountCode: "CASH_USDC",
          debitMinorUnits: "100",
          creditMinorUnits: "0",
          tokenMint: usdcMint,
          tokenBaseUnits: "1000000",
          walletId,
          chainSlot: "199",
        },
        {
          accountCode: "UNAPPLIED_CASH",
          debitMinorUnits: "0",
          creditMinorUnits: "100",
        },
      ],
    });
    await store.postJournal({
      organizationId,
      actorKind: "system",
      actorId: "ledger-worker",
      sourceType: "unapplied_receipt",
      sourceId: "receipt-other-wallet",
      sourceVersion: 1,
      functionalCurrency: "USD",
      description: "Other wallet receipt must not leak into reconciliation",
      occurredAt: new Date("2026-08-12T12:06:00.000Z"),
      lines: [
        {
          accountCode: "CASH_USDC",
          debitMinorUnits: "100",
          creditMinorUnits: "0",
          tokenMint: usdcMint,
          tokenBaseUnits: "5000000",
          walletId: otherWalletId,
          chainSlot: "150",
        },
        {
          accountCode: "UNAPPLIED_CASH",
          debitMinorUnits: "0",
          creditMinorUnits: "100",
        },
      ],
    });
    await store.postJournal({
      organizationId,
      actorKind: "system",
      actorId: "ledger-worker",
      sourceType: "unapplied_receipt",
      sourceId: "receipt-later-slot",
      sourceVersion: 1,
      functionalCurrency: "USD",
      description: "Later receipt must not leak into prior comparison",
      occurredAt: new Date("2026-08-12T12:07:00.000Z"),
      lines: [
        {
          accountCode: "CASH_USDC",
          debitMinorUnits: "200",
          creditMinorUnits: "0",
          tokenMint: usdcMint,
          tokenBaseUnits: "2000000",
          walletId,
          chainSlot: "300",
        },
        {
          accountCode: "UNAPPLIED_CASH",
          debitMinorUnits: "0",
          creditMinorUnits: "200",
        },
      ],
    });
    const matched = await store.reconcileWallet({
      organizationId,
      actorId: "ledger-worker",
      walletId,
      mint: usdcMint,
      comparisonSlot: "200",
      observedBaseUnits: "1000000",
      coverageComplete: true,
      reasonCode: "scheduled_check",
      now: new Date("2026-08-12T12:10:00.000Z"),
    });
    expect(matched).toMatchObject({
      ledgerBaseUnits: "1000000",
      differenceBaseUnits: "0",
      coverageState: "complete",
      balanceState: "matched",
    });
    await expect(
      store.reconcileWallet({
        organizationId,
        actorId: "ledger-worker",
        walletId,
        mint: usdcMint,
        comparisonSlot: "201",
        observedBaseUnits: "999999",
        coverageComplete: true,
        reasonCode: "scheduled_check",
        now: new Date("2026-08-12T12:11:00.000Z"),
      }),
    ).resolves.toMatchObject({
      balanceState: "mismatch",
      differenceBaseUnits: "-1",
    });
    await expect(
      store.reconcileWallet({
        organizationId,
        actorId: "ledger-worker",
        walletId,
        mint: usdcMint,
        comparisonSlot: "202",
        observedBaseUnits: "1000000",
        coverageComplete: false,
        reasonCode: "rpc_gap",
        now: new Date("2026-08-12T12:12:00.000Z"),
      }),
    ).resolves.toMatchObject({
      coverageState: "incomplete",
      balanceState: "matched",
    });
  });

  it("generates deterministic formula-safe journal and QuickBooks CSV exports", async () => {
    await store.ensureDefaultAccounts({
      organizationId,
      actorId: "ledger-worker",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    await store.postJournal({
      organizationId,
      actorKind: "system",
      actorId: "ledger-worker",
      sourceType: "adjustment",
      sourceId: "manual-adjustment-1",
      sourceVersion: 1,
      functionalCurrency: "USD",
      description: "=HYPERLINK malicious spreadsheet formula",
      occurredAt: new Date("2026-08-12T12:05:00.000Z"),
      lines: [
        {
          accountCode: "ACCOUNTS_RECEIVABLE",
          debitMinorUnits: "100",
          creditMinorUnits: "0",
        },
        {
          accountCode: "UNAPPLIED_CASH",
          debitMinorUnits: "0",
          creditMinorUnits: "100",
        },
      ],
    });
    const exports = new AccountingExportService(database);
    const input = {
      organizationId,
      actorKind: "session" as const,
      actorId: "merchant-accountant",
      fromTime: new Date("2026-08-12T00:00:00.000Z"),
      throughTime: new Date("2026-08-13T00:00:00.000Z"),
      now: new Date("2026-08-13T00:01:00.000Z"),
    };
    const journals = await exports.generate({
      ...input,
      format: "journals_csv",
    });
    const journalCsv = new TextDecoder().decode(journals.contentBytes);
    expect(journalCsv).toContain(
      "Journal ID,Occurred At,Source Type,Source ID,Source Version,Account Code,Debit Minor Units,Credit Minor Units,Currency,Token Mint,Token Base Units,Memo,Description\r\n",
    );
    expect(journalCsv).toContain("'=HYPERLINK malicious spreadsheet formula");
    expect(journals.rowCount).toBe(2);
    expect(journals.contentDigest).toBe(
      createHash("sha256").update(journals.contentBytes).digest("hex"),
    );
    const quickbooks = await exports.generate({
      ...input,
      format: "quickbooks_csv",
    });
    expect(new TextDecoder().decode(quickbooks.contentBytes)).toContain(
      "Date,Journal No,Account,Debit,Credit,Memo,Currency\r\n",
    );
    expect(new TextDecoder().decode(quickbooks.contentBytes)).toContain(
      ",1.00,0.00,",
    );
    expect(quickbooks.rowCount).toBe(2);
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) => sql`DELETE FROM accounting_exports`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back export and audit when idempotency completion fails", async () => {
    const exports = new AccountingExportService(database);
    await expect(
      exports.generate({
        organizationId,
        actorKind: "session",
        actorId: "merchant-accountant",
        format: "journals_csv",
        fromTime: new Date("2026-08-12T00:00:00.000Z"),
        throughTime: new Date("2026-08-13T00:00:00.000Z"),
        now: new Date("2026-08-13T00:01:00.000Z"),
        auditRequestId: randomUUID(),
        idempotency: {
          status: 201,
          responseBody: (record) => ({ id: record.id }),
          committer: {
            complete: async () => {
              throw new Error("forced idempotency failure");
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "accounting_export_unavailable" });
    await expect(count(database, "accounting_exports")).resolves.toBe(0);
    await expect(count(database, "audit_events")).resolves.toBe(0);
  });
});

async function seedWallet(
  database: OrganizationDatabase,
  walletId: string,
  active = true,
) {
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      await sql`
        INSERT INTO merchant_wallets (
          id, organization_id, address, cluster, status, verified_at,
          replaced_at, created_at, updated_at
        ) VALUES (
          ${walletId}::uuid, ${organizationId}::uuid,
          ${walletId.replaceAll("-", "")}, 'mainnet-beta',
          ${active ? "active" : "replaced"}, now(),
          ${active ? null : new Date("2026-08-12T00:00:00.000Z")}, now(), now()
        )
      `;
    },
  );
}

async function count(database: OrganizationDatabase, table: string) {
  return database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      const [row] = await sql.unsafe<{ count: number }[]>(
        `SELECT count(*)::integer AS count FROM ${table}`,
      );
      return row!.count;
    },
  );
}

async function insertRawCashJournal(
  database: OrganizationDatabase,
  input: {
    readonly sourceId: string;
    readonly walletId: string;
    readonly tokenMint: string | null;
  },
) {
  return database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      const journalId = randomUUID();
      const accounts = await sql<{ id: string; code: string }[]>`
        SELECT id::text, code FROM ledger_accounts
        WHERE organization_id = ${organizationId}::uuid
          AND code IN ('CASH_USDC', 'UNAPPLIED_CASH')
      `;
      const account = new Map(accounts.map((row) => [row.code, row.id]));
      await sql`
        INSERT INTO journal_entries (
          id, organization_id, source_type, source_id, source_version,
          functional_currency, description, payload_digest, occurred_at,
          posted_by, created_at
        ) VALUES (
          ${journalId}::uuid, ${organizationId}::uuid, 'adjustment',
          ${input.sourceId}, 1, 'USD', 'Direct SQL provenance bypass',
          ${"d".repeat(64)}, now(), 'test', now()
        )
      `;
      await sql`
        INSERT INTO journal_lines (
          organization_id, journal_entry_id, line_number, account_id,
          debit_minor_units, credit_minor_units, token_mint,
          token_base_units, wallet_id, chain_slot
        ) VALUES
          (
            ${organizationId}::uuid, ${journalId}::uuid, 1,
            ${account.get("CASH_USDC")!}::uuid, 100, 0,
            ${input.tokenMint}, ${input.tokenMint === null ? null : "1000000"},
            ${input.tokenMint === null ? null : input.walletId}::uuid,
            ${input.tokenMint === null ? null : "200"}::bigint
          ),
          (
            ${organizationId}::uuid, ${journalId}::uuid, 2,
            ${account.get("UNAPPLIED_CASH")!}::uuid, 0, 100,
            NULL, NULL, NULL, NULL
          )
      `;
    },
  );
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
