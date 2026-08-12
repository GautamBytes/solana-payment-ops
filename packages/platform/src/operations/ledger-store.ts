import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "../audit/audit-store.js";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import { canonicalJson } from "../idempotency/idempotency-store.js";
import { assetBySymbol } from "../wallets/asset-registry.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const codePattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const safeSourcePattern = /^[\x21-\x7e]{1,128}$/;
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/;
const unsignedIntegerPattern = /^(0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const maximumU64 = 18_446_744_073_709_551_615n;
const maximumMinorUnits = 10n ** 38n - 1n;
const maximumSlot = 9_223_372_036_854_775_807n;
const cashAccountMints = Object.freeze({
  CASH_USDC: assetBySymbol("USDC").mint,
  CASH_USDT: assetBySymbol("USDT").mint,
} as const);

export type FunctionalCurrency = "USD" | "EUR" | "GBP" | "INR";
export type JournalSourceType =
  | "invoice_issued"
  | "invoice_cancelled"
  | "payment_received"
  | "unapplied_receipt"
  | "cash_allocated"
  | "opening_balance"
  | "adjustment"
  | "refund_prepared";

export interface JournalLineInput {
  readonly accountCode: string;
  readonly debitMinorUnits: string;
  readonly creditMinorUnits: string;
  readonly tokenMint?: string;
  readonly tokenBaseUnits?: string;
  readonly walletId?: string;
  readonly chainSlot?: string;
  readonly memo?: string;
}

export interface PostJournalInput {
  readonly organizationId: string;
  readonly actorKind: "session" | "api_key" | "system";
  readonly actorId: string;
  readonly sourceType: JournalSourceType;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly functionalCurrency: FunctionalCurrency;
  readonly description: string;
  readonly occurredAt: Date;
  readonly lines: readonly JournalLineInput[];
  readonly auditRequestId?: string;
}

export interface JournalRecord {
  readonly id: string;
  readonly sourceType: JournalSourceType;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly functionalCurrency: FunctionalCurrency;
  readonly description: string;
  readonly occurredAt: string;
  readonly postedBy: string;
  readonly debitMinorUnits: string;
  readonly creditMinorUnits: string;
  readonly lineCount: number;
  readonly createdAt: string;
}

export interface LedgerReconciliationRecord {
  readonly id: string;
  readonly walletId: string;
  readonly mint: string;
  readonly comparisonSlot: string;
  readonly observedBaseUnits: string;
  readonly ledgerBaseUnits: string;
  readonly differenceBaseUnits: string;
  readonly coverageState: "complete" | "incomplete";
  readonly balanceState: "matched" | "mismatch";
  readonly reasonCode: string;
  readonly reconciledAt: string;
}

export class LedgerStoreError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super("Ledger operation failed", cause === undefined ? {} : { cause });
    this.name = "LedgerStoreError";
    this.code = code;
  }
}

const defaultAccounts = [
  ["ACCOUNTS_RECEIVABLE", "Accounts receivable", "asset", "debit"],
  ["INVOICE_CLEARING", "Invoice clearing", "clearing", "credit"],
  ["CASH_USDC", "On-chain USDC cash", "asset", "debit"],
  ["CASH_USDT", "On-chain USDT cash", "asset", "debit"],
  ["UNAPPLIED_CASH", "Unapplied cash", "liability", "credit"],
  ["FX_GAIN_LOSS", "Realized FX gain or loss", "revenue", "credit"],
  ["UNCLASSIFIED_OUTFLOW", "Unclassified outflow", "clearing", "debit"],
] as const;

export class LedgerStore {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async ensureDefaultAccounts(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly now: Date;
  }): Promise<void> {
    assertDate(input.now);
    await this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => ensureDefaultLedgerAccounts(sql, input),
    );
  }

  public async postJournal(input: PostJournalInput): Promise<JournalRecord> {
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (sql) => postJournalEntry(sql, input),
      );
    } catch (error) {
      if (error instanceof LedgerStoreError) throw error;
      throw new LedgerStoreError("ledger_store_unavailable", error);
    }
  }

  public async reconcileWallet(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly walletId: string;
    readonly mint: string;
    readonly comparisonSlot: string;
    readonly observedBaseUnits: string;
    readonly coverageComplete: boolean;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<LedgerReconciliationRecord> {
    validateReconciliation(input);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (sql) => {
          const rows = await sql<{ total: string }[]>`
            SELECT COALESCE(sum(
              CASE WHEN line.debit_minor_units > 0
                THEN line.token_base_units ELSE -line.token_base_units END
            ), 0)::text AS total
            FROM journal_lines AS line
            JOIN ledger_accounts AS account
              ON account.organization_id = line.organization_id
              AND account.id = line.account_id
            WHERE line.organization_id = ${input.organizationId}::uuid
              AND line.token_mint = ${input.mint}
              AND line.wallet_id = ${input.walletId}::uuid
              AND line.chain_slot <= ${input.comparisonSlot}::bigint
              AND account.code IN ('CASH_USDC', 'CASH_USDT')
          `;
          const ledger = BigInt(rows[0]!.total);
          const observed = BigInt(input.observedBaseUnits);
          const difference = observed - ledger;
          const id = randomUUID();
          const coverageState = input.coverageComplete
            ? "complete"
            : "incomplete";
          const balanceState = difference === 0n ? "matched" : "mismatch";
          const inserted = await sql<ReconciliationRow[]>`
            INSERT INTO ledger_reconciliations (
              id, organization_id, wallet_id, mint, comparison_slot,
              observed_base_units, ledger_base_units, difference_base_units,
              coverage_state, balance_state, reason_code, reconciled_at, created_at
            ) VALUES (
              ${id}::uuid, ${input.organizationId}::uuid, ${input.walletId}::uuid,
              ${input.mint}, ${input.comparisonSlot}, ${input.observedBaseUnits},
              ${ledger.toString()}, ${difference.toString()}, ${coverageState},
              ${balanceState}, ${input.reasonCode}, ${input.now.toISOString()},
              ${input.now.toISOString()}
            )
            RETURNING id::text, wallet_id::text, mint, comparison_slot::text,
              observed_base_units::text, ledger_base_units::text,
              difference_base_units::text, coverage_state, balance_state,
              reason_code, reconciled_at
          `;
          return toReconciliation(inserted[0]!);
        },
      );
    } catch (error) {
      if (error instanceof LedgerStoreError) throw error;
      throw new LedgerStoreError("ledger_store_unavailable", error);
    }
  }
}

export async function ensureDefaultLedgerAccounts(
  sql: OrganizationTransaction,
  input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly now: Date;
  },
): Promise<void> {
  assertDate(input.now);
  for (const [code, name, category, normalBalance] of defaultAccounts) {
    await sql`
      INSERT INTO ledger_accounts (
        id, organization_id, code, name, category, normal_balance,
        system_account, active, created_at
      ) VALUES (
        ${randomUUID()}::uuid, ${input.organizationId}::uuid, ${code},
        ${name}, ${category}, ${normalBalance}, true, true,
        ${input.now.toISOString()}
      ) ON CONFLICT (organization_id, code) DO NOTHING
    `;
  }
}

export async function postJournalEntry(
  sql: OrganizationTransaction,
  input: PostJournalInput,
): Promise<JournalRecord> {
  const normalized = normalizeJournal(input);
  const payloadDigest = createHash("sha256")
    .update(canonicalJson(normalized), "utf8")
    .digest("hex");
  const identity = `${input.organizationId}:${normalized.sourceType}:${normalized.sourceId}:${normalized.sourceVersion}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
  const existing = await sql<{ id: string; payload_digest: string }[]>`
    SELECT id::text, payload_digest FROM journal_entries
    WHERE organization_id = ${input.organizationId}::uuid
      AND source_type = ${normalized.sourceType}
      AND source_id = ${normalized.sourceId}
      AND source_version = ${normalized.sourceVersion}
  `;
  if (existing[0] !== undefined) {
    if (existing[0].payload_digest !== payloadDigest) {
      throw new LedgerStoreError("journal_source_conflict");
    }
    return readJournal(sql, input.organizationId, existing[0].id);
  }
  const codes = normalized.lines.map((line) => line.accountCode);
  const accountRows = await sql<{ id: string; code: string }[]>`
    SELECT id::text, code FROM ledger_accounts
    WHERE organization_id = ${input.organizationId}::uuid
      AND code = ANY(${codes}) AND active
  `;
  const accounts = new Map(accountRows.map((row) => [row.code, row.id]));
  if (accounts.size !== new Set(codes).size) {
    throw new LedgerStoreError("ledger_account_not_found");
  }
  const journalId = randomUUID();
  await sql`
    INSERT INTO journal_entries (
      id, organization_id, source_type, source_id, source_version,
      functional_currency, description, payload_digest, occurred_at,
      posted_by, created_at
    ) VALUES (
      ${journalId}::uuid, ${input.organizationId}::uuid,
      ${normalized.sourceType}, ${normalized.sourceId},
      ${normalized.sourceVersion}, ${normalized.functionalCurrency},
      ${normalized.description}, ${payloadDigest},
      ${normalized.occurredAt}, ${input.actorId}, ${normalized.occurredAt}
    )
  `;
  for (const [index, line] of normalized.lines.entries()) {
    await sql`
      INSERT INTO journal_lines (
        organization_id, journal_entry_id, line_number, account_id,
        debit_minor_units, credit_minor_units, token_mint,
        token_base_units, wallet_id, chain_slot, memo
      ) VALUES (
        ${input.organizationId}::uuid, ${journalId}::uuid, ${index + 1},
        ${accounts.get(line.accountCode)!}::uuid,
        ${line.debitMinorUnits}, ${line.creditMinorUnits},
        ${line.tokenMint}, ${line.tokenBaseUnits}, ${line.walletId}::uuid,
        ${line.chainSlot}::bigint, ${line.memo}
      )
    `;
  }
  if (input.auditRequestId !== undefined) {
    await appendAuditEvent(sql, {
      organizationId: input.organizationId,
      actorKind: input.actorKind,
      actorId: input.actorId,
      action: "journal.post",
      objectKind: "journal_entry",
      objectId: journalId,
      requestId: input.auditRequestId,
      outcome: "succeeded",
      reasonCode: normalized.sourceType,
      occurredAt: input.occurredAt,
    });
  }
  return readJournal(sql, input.organizationId, journalId);
}

interface NormalizedLine {
  readonly accountCode: string;
  readonly debitMinorUnits: string;
  readonly creditMinorUnits: string;
  readonly tokenMint: string | null;
  readonly tokenBaseUnits: string | null;
  readonly walletId: string | null;
  readonly chainSlot: string | null;
  readonly memo: string | null;
}

interface JournalRow {
  readonly id: string;
  readonly source_type: JournalSourceType;
  readonly source_id: string;
  readonly source_version: number;
  readonly functional_currency: FunctionalCurrency;
  readonly description: string;
  readonly occurred_at: Date;
  readonly posted_by: string;
  readonly debit_minor_units: string;
  readonly credit_minor_units: string;
  readonly line_count: number;
  readonly created_at: Date;
}

interface ReconciliationRow {
  readonly id: string;
  readonly wallet_id: string;
  readonly mint: string;
  readonly comparison_slot: string;
  readonly observed_base_units: string;
  readonly ledger_base_units: string;
  readonly difference_base_units: string;
  readonly coverage_state: "complete" | "incomplete";
  readonly balance_state: "matched" | "mismatch";
  readonly reason_code: string;
  readonly reconciled_at: Date;
}

function normalizeJournal(input: {
  readonly sourceType: JournalSourceType;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly functionalCurrency: FunctionalCurrency;
  readonly description: string;
  readonly occurredAt: Date;
  readonly lines: readonly JournalLineInput[];
}) {
  if (
    !safeSourcePattern.test(input.sourceId) ||
    !Number.isSafeInteger(input.sourceVersion) ||
    input.sourceVersion < 1 ||
    !["USD", "EUR", "GBP", "INR"].includes(input.functionalCurrency) ||
    input.lines.length < 2 ||
    input.lines.length > 100
  ) {
    throw new LedgerStoreError("invalid_journal");
  }
  assertDate(input.occurredAt);
  const description = boundedText(
    input.description,
    500,
    "invalid_journal_description",
  );
  let debit = 0n;
  let credit = 0n;
  const lines = input.lines.map((line) => {
    if (!codePattern.test(line.accountCode)) {
      throw new LedgerStoreError("invalid_ledger_account_code");
    }
    const debitValue = parseAmount(line.debitMinorUnits, maximumMinorUnits);
    const creditValue = parseAmount(line.creditMinorUnits, maximumMinorUnits);
    if (debitValue > 0n === creditValue > 0n) {
      throw new LedgerStoreError("invalid_journal_line");
    }
    const tokenPaired =
      line.tokenMint !== undefined && line.tokenBaseUnits !== undefined;
    const provenancePaired =
      line.walletId !== undefined && line.chainSlot !== undefined;
    const expectedCashMint =
      line.accountCode in cashAccountMints
        ? cashAccountMints[line.accountCode as keyof typeof cashAccountMints]
        : undefined;
    if (
      (line.tokenMint === undefined) !==
      (line.tokenBaseUnits === undefined)
    ) {
      throw new LedgerStoreError("invalid_token_quantity");
    }
    if (
      tokenPaired &&
      (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(line.tokenMint!) ||
        parsePositiveAmount(line.tokenBaseUnits!, maximumU64) < 1n)
    ) {
      throw new LedgerStoreError("invalid_token_quantity");
    }
    if (
      (line.walletId === undefined) !== (line.chainSlot === undefined) ||
      (expectedCashMint !== undefined &&
        (!tokenPaired ||
          !provenancePaired ||
          line.tokenMint !== expectedCashMint)) ||
      (provenancePaired && !tokenPaired) ||
      (provenancePaired &&
        (!uuidPattern.test(line.walletId!) ||
          parseAmount(line.chainSlot!, maximumSlot) < 0n))
    ) {
      throw new LedgerStoreError("invalid_token_provenance");
    }
    debit += debitValue;
    credit += creditValue;
    return Object.freeze({
      accountCode: line.accountCode,
      debitMinorUnits: debitValue.toString(),
      creditMinorUnits: creditValue.toString(),
      tokenMint: line.tokenMint ?? null,
      tokenBaseUnits: line.tokenBaseUnits ?? null,
      walletId: line.walletId ?? null,
      chainSlot: line.chainSlot ?? null,
      memo:
        line.memo === undefined
          ? null
          : boundedText(line.memo, 500, "invalid_journal_memo"),
    }) satisfies NormalizedLine;
  });
  if (debit !== credit) throw new LedgerStoreError("journal_unbalanced");
  return Object.freeze({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    functionalCurrency: input.functionalCurrency,
    description,
    occurredAt: input.occurredAt.toISOString(),
    lines,
  });
}

async function readJournal(
  sql: OrganizationTransaction,
  organizationId: string,
  journalId: string,
): Promise<JournalRecord> {
  const rows = await sql<JournalRow[]>`
    SELECT entry.id::text, entry.source_type, entry.source_id,
      entry.source_version, entry.functional_currency, entry.description,
      entry.occurred_at, entry.posted_by,
      sum(line.debit_minor_units)::text AS debit_minor_units,
      sum(line.credit_minor_units)::text AS credit_minor_units,
      count(*)::integer AS line_count, entry.created_at
    FROM journal_entries AS entry
    JOIN journal_lines AS line
      ON line.organization_id = entry.organization_id
      AND line.journal_entry_id = entry.id
    WHERE entry.organization_id = ${organizationId}::uuid
      AND entry.id = ${journalId}::uuid
    GROUP BY entry.id
  `;
  const row = rows[0];
  if (row === undefined) throw new LedgerStoreError("journal_not_found");
  return Object.freeze({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    functionalCurrency: row.functional_currency,
    description: row.description,
    occurredAt: row.occurred_at.toISOString(),
    postedBy: row.posted_by,
    debitMinorUnits: row.debit_minor_units,
    creditMinorUnits: row.credit_minor_units,
    lineCount: row.line_count,
    createdAt: row.created_at.toISOString(),
  });
}

function validateReconciliation(input: {
  readonly walletId: string;
  readonly mint: string;
  readonly comparisonSlot: string;
  readonly observedBaseUnits: string;
  readonly reasonCode: string;
  readonly now: Date;
}): void {
  if (
    !uuidPattern.test(input.walletId) ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(input.mint) ||
    !reasonPattern.test(input.reasonCode)
  ) {
    throw new LedgerStoreError("invalid_reconciliation");
  }
  parseAmount(input.comparisonSlot, maximumSlot);
  parseAmount(input.observedBaseUnits, maximumU64);
  assertDate(input.now);
}

function parseAmount(value: string, maximum: bigint): bigint {
  if (!unsignedIntegerPattern.test(value)) {
    throw new LedgerStoreError("invalid_integer_amount");
  }
  const parsed = BigInt(value);
  if (parsed > maximum) throw new LedgerStoreError("invalid_integer_amount");
  return parsed;
}

function parsePositiveAmount(value: string, maximum: bigint): bigint {
  if (!positiveIntegerPattern.test(value)) {
    throw new LedgerStoreError("invalid_integer_amount");
  }
  return parseAmount(value, maximum);
}

function boundedText(value: string, maximum: number, code: string): string {
  const normalized = value.trim().normalize("NFC");
  if (
    [...normalized].length < 1 ||
    [...normalized].length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new LedgerStoreError(code);
  }
  return normalized;
}

function assertDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new LedgerStoreError("invalid_ledger_time");
  }
}

function toReconciliation(row: ReconciliationRow): LedgerReconciliationRecord {
  return Object.freeze({
    id: row.id,
    walletId: row.wallet_id,
    mint: row.mint,
    comparisonSlot: row.comparison_slot,
    observedBaseUnits: row.observed_base_units,
    ledgerBaseUnits: row.ledger_base_units,
    differenceBaseUnits: row.difference_base_units,
    coverageState: row.coverage_state,
    balanceState: row.balance_state,
    reasonCode: row.reason_code,
    reconciledAt: row.reconciled_at.toISOString(),
  });
}
