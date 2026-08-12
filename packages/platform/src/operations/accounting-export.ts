import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent } from "../audit/audit-store.js";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import type { IdempotencyResponseCommitter } from "../idempotency/idempotency-store.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumRangeMs = 366 * 24 * 60 * 60 * 1000;
const maximumExportBytes = 52_428_800;
const maximumExportRows = 100_000;

export const ACCOUNTING_EXPORT_FORMATS = [
  "payments_csv",
  "invoices_csv",
  "allocations_csv",
  "journals_csv",
  "quickbooks_csv",
] as const;
export type AccountingExportFormat = (typeof ACCOUNTING_EXPORT_FORMATS)[number];

export interface AccountingExportRecord {
  readonly id: string;
  readonly format: AccountingExportFormat;
  readonly fromTime: string;
  readonly throughTime: string;
  readonly contentBytes: Uint8Array;
  readonly contentDigest: string;
  readonly rowCount: number;
  readonly generatedAt: string;
}

export class AccountingExportError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super("Accounting export failed", cause === undefined ? {} : { cause });
    this.name = "AccountingExportError";
    this.code = code;
  }
}

export class AccountingExportService {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async generate(input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key" | "system";
    readonly actorId: string;
    readonly format: AccountingExportFormat;
    readonly fromTime: Date;
    readonly throughTime: Date;
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: {
      readonly committer: IdempotencyResponseCommitter;
      readonly status: number;
      readonly responseBody: (record: AccountingExportRecord) => unknown;
    };
  }): Promise<AccountingExportRecord> {
    validateGenerate(input);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (sql) => {
          const document = await buildExport(sql, input);
          const contentBytes = new TextEncoder().encode(document.csv);
          if (contentBytes.byteLength > maximumExportBytes) {
            throw new AccountingExportError("accounting_export_too_large");
          }
          const contentDigest = createHash("sha256")
            .update(contentBytes)
            .digest("hex");
          const id = randomUUID();
          await sql`
            INSERT INTO accounting_exports (
              id, organization_id, format, from_time, through_time,
              content_bytes, content_digest, row_count, generated_by,
              generated_at, created_at
            ) VALUES (
              ${id}::uuid, ${input.organizationId}::uuid, ${input.format},
              ${input.fromTime.toISOString()}, ${input.throughTime.toISOString()},
              ${contentBytes}, ${contentDigest}, ${document.rowCount},
              ${input.actorId}, ${input.now.toISOString()}, ${input.now.toISOString()}
            )
          `;
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(sql, {
              organizationId: input.organizationId,
              actorKind: input.actorKind,
              actorId: input.actorId,
              action: "accounting_export.generate",
              objectKind: "accounting_export",
              objectId: id,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: input.format,
              occurredAt: input.now,
            });
          }
          const record = freezeRecord({
            id,
            format: input.format,
            fromTime: input.fromTime.toISOString(),
            throughTime: input.throughTime.toISOString(),
            contentBytes,
            contentDigest,
            rowCount: document.rowCount,
            generatedAt: input.now.toISOString(),
          });
          if (input.idempotency !== undefined) {
            await input.idempotency.committer.complete(
              sql,
              input.idempotency.status,
              input.idempotency.responseBody(record),
            );
          }
          return record;
        },
      );
    } catch (error) {
      if (error instanceof AccountingExportError) throw error;
      throw new AccountingExportError("accounting_export_unavailable", error);
    }
  }

  public async get(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly exportId: string;
  }): Promise<AccountingExportRecord | null> {
    if (!uuidPattern.test(input.exportId)) return null;
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const rows = await sql<ExportRow[]>`
          SELECT id::text, format, from_time, through_time, content_bytes,
            content_digest, row_count, generated_at
          FROM accounting_exports
          WHERE organization_id = ${input.organizationId}::uuid
            AND id = ${input.exportId}::uuid
        `;
        const row = rows[0];
        return row === undefined
          ? null
          : freezeRecord({
              id: row.id,
              format: row.format,
              fromTime: row.from_time.toISOString(),
              throughTime: row.through_time.toISOString(),
              contentBytes: row.content_bytes,
              contentDigest: row.content_digest,
              rowCount: row.row_count,
              generatedAt: row.generated_at.toISOString(),
            });
      },
    );
  }
}

interface ExportRow {
  readonly id: string;
  readonly format: AccountingExportFormat;
  readonly from_time: Date;
  readonly through_time: Date;
  readonly content_bytes: Uint8Array;
  readonly content_digest: string;
  readonly row_count: number;
  readonly generated_at: Date;
}

interface JournalExportRow {
  readonly journal_id: string;
  readonly occurred_at: Date;
  readonly source_type: string;
  readonly source_id: string;
  readonly source_version: number;
  readonly account_code: string;
  readonly debit_minor_units: string;
  readonly credit_minor_units: string;
  readonly functional_currency: string;
  readonly token_mint: string | null;
  readonly token_base_units: string | null;
  readonly memo: string | null;
  readonly description: string;
}

async function buildExport(
  sql: OrganizationTransaction,
  input: {
    readonly organizationId: string;
    readonly format: AccountingExportFormat;
    readonly fromTime: Date;
    readonly throughTime: Date;
  },
): Promise<{ readonly csv: string; readonly rowCount: number }> {
  switch (input.format) {
    case "journals_csv":
    case "quickbooks_csv": {
      const rows = await sql<JournalExportRow[]>`
        SELECT entry.id::text AS journal_id, entry.occurred_at,
          entry.source_type, entry.source_id, entry.source_version,
          account.code AS account_code, line.debit_minor_units::text,
          line.credit_minor_units::text, entry.functional_currency,
          line.token_mint, line.token_base_units::text, line.memo,
          entry.description
        FROM journal_entries AS entry
        JOIN journal_lines AS line
          ON line.organization_id = entry.organization_id
          AND line.journal_entry_id = entry.id
        JOIN ledger_accounts AS account
          ON account.organization_id = line.organization_id
          AND account.id = line.account_id
        WHERE entry.organization_id = ${input.organizationId}::uuid
          AND entry.occurred_at >= ${input.fromTime.toISOString()}
          AND entry.occurred_at < ${input.throughTime.toISOString()}
        ORDER BY entry.occurred_at, entry.id, line.line_number
        LIMIT ${maximumExportRows + 1}
      `;
      return input.format === "journals_csv"
        ? journalCsv(rows)
        : quickBooksCsv(rows);
    }
    case "invoices_csv": {
      const rows = await sql<
        {
          id: string;
          public_reference: string;
          external_id: string | null;
          customer_id: string;
          currency: string;
          subtotal: string;
          tax: string;
          total: string;
          status: string;
          due_at: Date;
          issued_at: Date | null;
          created_at: Date;
        }[]
      >`
        SELECT id::text, public_reference, external_id, customer_id::text,
          currency, subtotal_minor_units::text AS subtotal,
          tax_minor_units::text AS tax, total_minor_units::text AS total,
          status, due_at, issued_at, created_at
        FROM merchant_invoices
        WHERE organization_id = ${input.organizationId}::uuid
          AND created_at >= ${input.fromTime.toISOString()}
          AND created_at < ${input.throughTime.toISOString()}
        ORDER BY created_at, id
        LIMIT ${maximumExportRows + 1}
      `;
      const header = [
        "Invoice ID",
        "Public Reference",
        "External ID",
        "Customer ID",
        "Currency",
        "Subtotal Minor Units",
        "Tax Minor Units",
        "Total Minor Units",
        "Status",
        "Due At",
        "Issued At",
        "Created At",
      ];
      return csvDocument(
        header,
        rows.map((row) => [
          text(row.id),
          text(row.public_reference),
          text(row.external_id),
          text(row.customer_id),
          text(row.currency),
          numeric(row.subtotal),
          numeric(row.tax),
          numeric(row.total),
          text(row.status),
          text(row.due_at.toISOString()),
          text(row.issued_at?.toISOString() ?? ""),
          text(row.created_at.toISOString()),
        ]),
      );
    }
    case "payments_csv": {
      const rows = await sql<
        {
          attempt_id: string;
          public_attempt_id: string;
          invoice_id: string;
          state: string;
          public_status: string | null;
          asset_symbol: string;
          mint: string;
          quoted_base_units: string;
          event_id: string | null;
          signature: string | null;
          received_base_units: string | null;
          outcome: string | null;
          created_at: Date;
          updated_at: Date;
        }[]
      >`
        SELECT attempt.id::text AS attempt_id,
          attempt.public_attempt_id::text, attempt.invoice_id::text,
          attempt.state, projection.public_status, attempt.asset_symbol,
          attempt.mint, quote.amount_base_units::text AS quoted_base_units,
          COALESCE(allocation.event_id, exception.event_id) AS event_id,
          COALESCE(allocation.signature, exception.signature) AS signature,
          COALESCE(allocation.amount_base_units, exception.amount_base_units)::text
            AS received_base_units,
          COALESCE(allocation.rule_code, exception.rule_code) AS outcome,
          attempt.created_at, attempt.updated_at
        FROM payment_attempts AS attempt
        JOIN payment_quotes AS quote
          ON quote.organization_id = attempt.organization_id
          AND quote.attempt_id = attempt.id
        LEFT JOIN payment_projections AS projection
          ON projection.organization_id = attempt.organization_id
          AND projection.attempt_id = attempt.id
        LEFT JOIN hosted_payment_allocations AS allocation
          ON allocation.organization_id = attempt.organization_id
          AND allocation.attempt_id = attempt.id
        LEFT JOIN hosted_payment_exceptions AS exception
          ON exception.organization_id = attempt.organization_id
          AND exception.attempt_id = attempt.id
        WHERE attempt.organization_id = ${input.organizationId}::uuid
          AND attempt.created_at >= ${input.fromTime.toISOString()}
          AND attempt.created_at < ${input.throughTime.toISOString()}
        ORDER BY attempt.created_at, attempt.id
        LIMIT ${maximumExportRows + 1}
      `;
      return csvDocument(
        [
          "Payment Attempt ID",
          "Public Payment ID",
          "Invoice ID",
          "Internal State",
          "Public Status",
          "Asset",
          "Mint",
          "Quoted Base Units",
          "Event ID",
          "Signature",
          "Received Base Units",
          "Outcome",
          "Created At",
          "Updated At",
        ],
        rows.map((row) => [
          text(row.attempt_id),
          text(row.public_attempt_id),
          text(row.invoice_id),
          text(row.state),
          text(row.public_status),
          text(row.asset_symbol),
          text(row.mint),
          numeric(row.quoted_base_units),
          text(row.event_id),
          text(row.signature),
          numeric(row.received_base_units ?? ""),
          text(row.outcome),
          text(row.created_at.toISOString()),
          text(row.updated_at.toISOString()),
        ]),
      );
    }
    case "allocations_csv": {
      const rows = await sql<
        {
          id: string;
          invoice_id: string;
          attempt_id: string;
          event_id: string;
          signature: string;
          mint: string;
          amount: string;
          rule_code: string;
          rule_version: string;
          created_at: Date;
        }[]
      >`
        SELECT id::text, invoice_id::text, attempt_id::text, event_id,
          signature, mint, amount_base_units::text AS amount, rule_code,
          rule_version, created_at
        FROM hosted_payment_allocations
        WHERE organization_id = ${input.organizationId}::uuid
          AND created_at >= ${input.fromTime.toISOString()}
          AND created_at < ${input.throughTime.toISOString()}
        ORDER BY created_at, id
        LIMIT ${maximumExportRows + 1}
      `;
      const header = [
        "Allocation ID",
        "Invoice ID",
        "Payment Attempt ID",
        "Event ID",
        "Signature",
        "Mint",
        "Amount Base Units",
        "Rule Code",
        "Rule Version",
        "Allocated At",
      ];
      return csvDocument(
        header,
        rows.map((row) => [
          text(row.id),
          text(row.invoice_id),
          text(row.attempt_id),
          text(row.event_id),
          text(row.signature),
          text(row.mint),
          numeric(row.amount),
          text(row.rule_code),
          text(row.rule_version),
          text(row.created_at.toISOString()),
        ]),
      );
    }
  }
}

function journalCsv(rows: readonly JournalExportRow[]) {
  const header = [
    "Journal ID",
    "Occurred At",
    "Source Type",
    "Source ID",
    "Source Version",
    "Account Code",
    "Debit Minor Units",
    "Credit Minor Units",
    "Currency",
    "Token Mint",
    "Token Base Units",
    "Memo",
    "Description",
  ];
  return csvDocument(
    header,
    rows.map((row) => [
      text(row.journal_id),
      text(row.occurred_at.toISOString()),
      text(row.source_type),
      text(row.source_id),
      numeric(String(row.source_version)),
      text(row.account_code),
      numeric(row.debit_minor_units),
      numeric(row.credit_minor_units),
      text(row.functional_currency),
      text(row.token_mint),
      numeric(row.token_base_units ?? ""),
      text(row.memo),
      text(row.description),
    ]),
  );
}

function minorUnitsToCurrency(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new AccountingExportError("corrupt_accounting_amount");
  }
  return `${value.slice(0, -2) || "0"}.${value.slice(-2).padStart(2, "0")}`;
}

function quickBooksCsv(rows: readonly JournalExportRow[]) {
  const header = [
    "Date",
    "Journal No",
    "Account",
    "Debit",
    "Credit",
    "Memo",
    "Currency",
  ];
  return csvDocument(
    header,
    rows.map((row) => [
      text(row.occurred_at.toISOString().slice(0, 10)),
      text(row.journal_id),
      text(row.account_code),
      numeric(minorUnitsToCurrency(row.debit_minor_units)),
      numeric(minorUnitsToCurrency(row.credit_minor_units)),
      text(row.memo ?? row.description),
      text(row.functional_currency),
    ]),
  );
}

interface CsvCell {
  readonly value: string;
  readonly numeric: boolean;
}

function text(value: string | null): CsvCell {
  const stringValue = value ?? "";
  return {
    value: /^[\t ]*[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue,
    numeric: false,
  };
}

function numeric(value: string): CsvCell {
  return { value, numeric: true };
}

function csvDocument(
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): { readonly csv: string; readonly rowCount: number } {
  if (rows.length > maximumExportRows) {
    throw new AccountingExportError("accounting_export_too_large");
  }
  const serialized = [
    header.map(escapeCsv).join(","),
    ...rows.map((row) => row.map((cell) => escapeCsv(cell.value)).join(",")),
  ];
  return { csv: `${serialized.join("\r\n")}\r\n`, rowCount: rows.length };
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function validateGenerate(input: {
  readonly organizationId: string;
  readonly format: AccountingExportFormat;
  readonly fromTime: Date;
  readonly throughTime: Date;
  readonly now: Date;
}): void {
  const from = input.fromTime.getTime();
  const through = input.throughTime.getTime();
  if (
    !uuidPattern.test(input.organizationId) ||
    !ACCOUNTING_EXPORT_FORMATS.includes(input.format) ||
    !Number.isFinite(from) ||
    !Number.isFinite(through) ||
    !Number.isFinite(input.now.getTime()) ||
    through <= from ||
    through - from > maximumRangeMs
  ) {
    throw new AccountingExportError("invalid_accounting_export");
  }
}

function freezeRecord(record: AccountingExportRecord): AccountingExportRecord {
  return Object.freeze({
    ...record,
    contentBytes: new Uint8Array(record.contentBytes),
  });
}
