import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createLifecycleEvent,
  enqueueLifecycleEvent,
  type LifecycleEvent,
} from "@payops/webhooks";
import { appendAuditEvent } from "../audit/audit-store.js";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import {
  canonicalJson,
  type IdempotencyResponseCommitter,
} from "../idempotency/idempotency-store.js";
import { assetBySymbol, type AssetSymbol } from "../wallets/asset-registry.js";
import {
  assertExpectedTotals,
  calculateInvoiceTotals,
  type CalculatedInvoiceLine,
} from "./arithmetic.js";
import {
  INVOICE_CURRENCIES,
  InvoiceError,
  type InvoiceCancellationReason,
  type InvoiceCurrency,
  type InvoiceIssuedSnapshot,
  type InvoiceLineInput,
  type InvoiceLineRecord,
  type InvoiceRecord,
  type InvoiceStatus,
} from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cancellationReasons = new Set<string>([
  "customer_request",
  "duplicate_invoice",
  "commercial_terms_changed",
  "merchant_error",
  "other_reviewed",
]);

export class InvoiceStore {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async create(input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key";
    readonly actorId: string;
    readonly externalId?: string | null;
    readonly customerId: string;
    readonly settlementWalletId: string;
    readonly acceptedAssetSymbols: readonly string[];
    readonly currency: string;
    readonly lines: readonly InvoiceLineInput[];
    readonly dueAt: Date;
    readonly expectedTotals?: {
      readonly subtotalMinorUnits?: string;
      readonly taxMinorUnits?: string;
      readonly totalMinorUnits?: string;
    };
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: IdempotencyResponseCommitter;
  }): Promise<InvoiceRecord> {
    validateDate(input.now);
    validateDate(input.dueAt);
    if (
      !uuidPattern.test(input.customerId) ||
      !uuidPattern.test(input.settlementWalletId)
    ) {
      throw new InvoiceError("invalid_invoice_reference");
    }
    const currency = parseCurrency(input.currency);
    const assets = normalizeAssets(input.acceptedAssetSymbols);
    const externalId = normalizeExternalId(input.externalId);
    const totals = calculateInvoiceTotals(input.lines);
    const lineRecords = totals.lines.map((line, index) => ({
      ...line,
      position: index + 1,
    }));
    assertExpectedTotals(totals, input.expectedTotals ?? {});
    const id = randomUUID();
    const publicReference = `INV-${randomBytes(8).toString("hex").toUpperCase()}`;
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (transaction) => {
          await requireCustomer(
            transaction,
            input.organizationId,
            input.customerId,
          );
          await requireWallet(
            transaction,
            input.organizationId,
            input.settlementWalletId,
            false,
          );
          const inserted = await transaction<InvoiceRow[]>`
            INSERT INTO merchant_invoices (
              id, organization_id, public_reference, external_id, customer_id,
              settlement_wallet_id, accepted_asset_symbols, currency, status,
              subtotal_minor_units, tax_minor_units, total_minor_units, due_at,
              version, created_at, updated_at
            ) VALUES (
              ${id}::uuid, ${input.organizationId}::uuid, ${publicReference},
              ${externalId}, ${input.customerId}::uuid,
              ${input.settlementWalletId}::uuid, ${assets}, ${currency}, 'draft',
              ${totals.subtotalMinorUnits}, ${totals.taxMinorUnits},
              ${totals.totalMinorUnits}, ${input.dueAt.toISOString()}, 1,
              ${input.now.toISOString()}, ${input.now.toISOString()}
            )
            RETURNING id::text, organization_id::text, public_reference,
              external_id, customer_id::text, settlement_wallet_id::text,
              accepted_asset_symbols, currency, status,
              subtotal_minor_units::text, tax_minor_units::text,
              total_minor_units::text, due_at, version, issued_at, cancelled_at,
              cancellation_reason, created_at, updated_at
          `;
          await insertLines(
            transaction,
            input.organizationId,
            id,
            totals.lines,
          );
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(transaction, {
              organizationId: input.organizationId,
              actorKind: input.actorKind,
              actorId: input.actorId,
              action: "invoice.create",
              objectKind: "invoice",
              objectId: id,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: "draft_created",
              occurredAt: input.now,
            });
          }
          const invoice = toInvoice(inserted[0]!, lineRecords);
          await input.idempotency?.complete(transaction, 201, invoice);
          return invoice;
        },
      );
    } catch (error) {
      throw mapInvoiceError(error);
    }
  }

  public async get(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly invoiceId: string;
  }): Promise<InvoiceRecord | null> {
    if (!uuidPattern.test(input.invoiceId)) return null;
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) =>
        loadInvoice(transaction, input.organizationId, input.invoiceId),
    );
  }

  public async list(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly limit: number;
    readonly status?: InvoiceStatus;
    readonly customerId?: string;
    readonly after?: { readonly createdAt: string; readonly id: string };
  }): Promise<readonly InvoiceRecord[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 101
    ) {
      throw new InvoiceError("invalid_invoice_list");
    }
    if (
      input.status !== undefined &&
      !["draft", "issued", "cancelled"].includes(input.status)
    ) {
      throw new InvoiceError("invalid_invoice_list");
    }
    if (input.customerId !== undefined && !uuidPattern.test(input.customerId)) {
      throw new InvoiceError("invalid_invoice_list");
    }
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) => {
        const rows = await transaction<InvoiceRow[]>`
          SELECT id::text, organization_id::text, public_reference,
            external_id, customer_id::text, settlement_wallet_id::text,
            accepted_asset_symbols, currency, status,
            subtotal_minor_units::text, tax_minor_units::text,
            total_minor_units::text, due_at, version, issued_at, cancelled_at,
            cancellation_reason, created_at, updated_at
          FROM merchant_invoices
          WHERE organization_id = ${input.organizationId}::uuid
            AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
            AND (${input.customerId ?? null}::uuid IS NULL OR customer_id = ${input.customerId ?? null}::uuid)
            AND (
              ${input.after?.createdAt ?? null}::timestamptz IS NULL
              OR (created_at, id) < (
                ${input.after?.createdAt ?? null}::timestamptz,
                ${input.after?.id ?? null}::uuid
              )
            )
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit}
        `;
        const output: InvoiceRecord[] = [];
        for (const row of rows) {
          output.push(
            toInvoice(
              row,
              await loadLines(transaction, input.organizationId, row.id),
            ),
          );
        }
        return output;
      },
    );
  }

  public async issue(input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key";
    readonly actorId: string;
    readonly invoiceId: string;
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: IdempotencyResponseCommitter;
  }): Promise<{
    readonly invoice: InvoiceRecord;
    readonly snapshot: InvoiceIssuedSnapshot;
  }> {
    validateDate(input.now);
    if (!uuidPattern.test(input.invoiceId))
      throw new InvoiceError("invoice_not_found");
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (transaction) => {
          const row = await lockInvoice(
            transaction,
            input.organizationId,
            input.invoiceId,
          );
          if (row.status !== "draft")
            throw new InvoiceError("invoice_not_draft");
          const dueMs = row.due_at.getTime() - input.now.getTime();
          if (dueMs <= 0 || dueMs > 366 * 24 * 60 * 60 * 1_000) {
            throw new InvoiceError("invalid_invoice_due_time");
          }
          const lines = await loadLines(
            transaction,
            input.organizationId,
            input.invoiceId,
          );
          const customer = await requireCustomer(
            transaction,
            input.organizationId,
            row.customer_id,
          );
          const walletAssets = await requireWallet(
            transaction,
            input.organizationId,
            row.settlement_wallet_id,
            true,
          );
          for (const symbol of row.accepted_asset_symbols) {
            if (!walletAssets.includes(symbol))
              throw new InvoiceError("invoice_asset_unavailable");
          }
          const version = row.version + 1;
          const issuedAt = input.now.toISOString();
          const snapshot: InvoiceIssuedSnapshot = {
            schemaVersion: "0.1",
            invoiceId: row.id,
            organizationId: row.organization_id,
            publicReference: row.public_reference,
            externalId: row.external_id,
            customer,
            currency: parseCurrency(row.currency),
            lines: lines.map(
              ({
                description,
                quantity,
                unitPriceMinorUnits,
                taxLabel,
                taxMinorUnits,
              }) => ({
                description,
                quantity,
                unitPriceMinorUnits,
                taxLabel,
                taxMinorUnits,
              }),
            ),
            subtotalMinorUnits: row.subtotal_minor_units,
            taxMinorUnits: row.tax_minor_units,
            totalMinorUnits: row.total_minor_units,
            dueAt: row.due_at.toISOString(),
            acceptedAssetSymbols: row.accepted_asset_symbols,
            settlementWalletId: row.settlement_wallet_id,
            issuedAt,
          };
          const canonicalSnapshot = canonicalJson(snapshot);
          await transaction`
            INSERT INTO merchant_invoice_issued_snapshots (
              organization_id, invoice_id, invoice_version, canonical_payload,
              payload_digest, created_at
            ) VALUES (
              ${input.organizationId}::uuid, ${input.invoiceId}::uuid, ${version},
              ${canonicalSnapshot},
              ${createHash("sha256").update(canonicalSnapshot, "utf8").digest("hex")},
              ${issuedAt}
            )
          `;
          const updated = await transaction<InvoiceRow[]>`
            UPDATE merchant_invoices SET status = 'issued', version = ${version},
              issued_at = ${issuedAt}, updated_at = ${issuedAt}
            WHERE organization_id = ${input.organizationId}::uuid
              AND id = ${input.invoiceId}::uuid AND status = 'draft'
            RETURNING id::text, organization_id::text, public_reference,
              external_id, customer_id::text, settlement_wallet_id::text,
              accepted_asset_symbols, currency, status,
              subtotal_minor_units::text, tax_minor_units::text,
              total_minor_units::text, due_at, version, issued_at, cancelled_at,
              cancellation_reason, created_at, updated_at
          `;
          if (updated.length !== 1)
            throw new InvoiceError("invoice_state_conflict");
          const event: LifecycleEvent = {
            type: "invoice.issued",
            statusAtOccurrence: "issued",
            object: { type: "invoice", id: row.id, version },
            data: {
              invoiceId: row.id,
              customerId: row.customer_id,
              publicReference: row.public_reference,
              currency: parseCurrency(row.currency),
              totalMinorUnits: row.total_minor_units,
              dueAt: row.due_at.toISOString(),
              issuedAt,
              acceptedAssetSymbols: row.accepted_asset_symbols,
            },
          };
          await enqueueLifecycleEvent(
            transaction,
            createLifecycleEvent(event, randomUUID(), input.now),
            input.now,
          );
          await auditIfRequested(
            transaction,
            input,
            "invoice.issue",
            row.id,
            "issued",
          );
          const result = { invoice: toInvoice(updated[0]!, lines), snapshot };
          await input.idempotency?.complete(transaction, 200, result);
          return result;
        },
      );
    } catch (error) {
      throw mapInvoiceError(error);
    }
  }

  public async cancel(input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key";
    readonly actorId: string;
    readonly invoiceId: string;
    readonly reasonCode: string;
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: IdempotencyResponseCommitter;
  }): Promise<InvoiceRecord> {
    validateDate(input.now);
    if (!uuidPattern.test(input.invoiceId))
      throw new InvoiceError("invoice_not_found");
    if (!cancellationReasons.has(input.reasonCode)) {
      throw new InvoiceError("invalid_cancellation_reason");
    }
    const reasonCode = input.reasonCode as InvoiceCancellationReason;
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (transaction) => {
          const row = await lockInvoice(
            transaction,
            input.organizationId,
            input.invoiceId,
          );
          if (row.status === "cancelled")
            throw new InvoiceError("invoice_already_cancelled");
          const allocation = await transaction<{ present: boolean }[]>`
            SELECT EXISTS(
              SELECT 1
              FROM reconciliation_allocations AS allocation
              JOIN reconciliation_invoices AS invoice
                ON invoice.invoice_id = allocation.invoice_id
              WHERE invoice.organization_id = ${input.organizationId}::uuid
                AND invoice.invoice_id = ${row.id}
            ) AS present
          `;
          if (allocation[0]?.present === true)
            throw new InvoiceError("invoice_has_payment");
          const previousState = row.status;
          const version = row.version + 1;
          const cancelledAt = input.now.toISOString();
          const updated = await transaction<InvoiceRow[]>`
            UPDATE merchant_invoices SET status = 'cancelled', version = ${version},
              cancelled_at = ${cancelledAt}, cancellation_reason = ${reasonCode},
              updated_at = ${cancelledAt}
            WHERE organization_id = ${input.organizationId}::uuid
              AND id = ${input.invoiceId}::uuid AND status = ${previousState}
            RETURNING id::text, organization_id::text, public_reference,
              external_id, customer_id::text, settlement_wallet_id::text,
              accepted_asset_symbols, currency, status,
              subtotal_minor_units::text, tax_minor_units::text,
              total_minor_units::text, due_at, version, issued_at, cancelled_at,
              cancellation_reason, created_at, updated_at
          `;
          if (updated.length !== 1)
            throw new InvoiceError("invoice_state_conflict");
          const event: LifecycleEvent = {
            type: "invoice.cancelled",
            statusAtOccurrence: "cancelled",
            object: { type: "invoice", id: row.id, version },
            data: {
              invoiceId: row.id,
              publicReference: row.public_reference,
              previousState,
              reasonCode,
              actorKind: input.actorKind === "session" ? "member" : "api_key",
              cancelledAt,
            },
          };
          await enqueueLifecycleEvent(
            transaction,
            createLifecycleEvent(event, randomUUID(), input.now),
            input.now,
          );
          await auditIfRequested(
            transaction,
            input,
            "invoice.cancel",
            row.id,
            "cancelled",
          );
          const invoice = toInvoice(
            updated[0]!,
            await loadLines(transaction, input.organizationId, row.id),
          );
          await input.idempotency?.complete(transaction, 200, invoice);
          return invoice;
        },
      );
    } catch (error) {
      throw mapInvoiceError(error);
    }
  }
}

interface InvoiceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly public_reference: string;
  readonly external_id: string | null;
  readonly customer_id: string;
  readonly settlement_wallet_id: string;
  readonly accepted_asset_symbols: AssetSymbol[];
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly subtotal_minor_units: string;
  readonly tax_minor_units: string;
  readonly total_minor_units: string;
  readonly due_at: Date;
  readonly version: number;
  readonly issued_at: Date | null;
  readonly cancelled_at: Date | null;
  readonly cancellation_reason: InvoiceCancellationReason | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

async function loadInvoice(
  transaction: OrganizationTransaction,
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceRecord | null> {
  const rows = await transaction<InvoiceRow[]>`
    SELECT id::text, organization_id::text, public_reference, external_id,
      customer_id::text, settlement_wallet_id::text, accepted_asset_symbols,
      currency, status, subtotal_minor_units::text, tax_minor_units::text,
      total_minor_units::text, due_at, version, issued_at, cancelled_at,
      cancellation_reason, created_at, updated_at
    FROM merchant_invoices
    WHERE organization_id = ${organizationId}::uuid AND id = ${invoiceId}::uuid
  `;
  if (rows[0] === undefined) return null;
  return toInvoice(
    rows[0],
    await loadLines(transaction, organizationId, invoiceId),
  );
}

async function lockInvoice(
  transaction: OrganizationTransaction,
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceRow> {
  const rows = await transaction<InvoiceRow[]>`
    SELECT id::text, organization_id::text, public_reference, external_id,
      customer_id::text, settlement_wallet_id::text, accepted_asset_symbols,
      currency, status, subtotal_minor_units::text, tax_minor_units::text,
      total_minor_units::text, due_at, version, issued_at, cancelled_at,
      cancellation_reason, created_at, updated_at
    FROM merchant_invoices
    WHERE organization_id = ${organizationId}::uuid AND id = ${invoiceId}::uuid
    FOR UPDATE
  `;
  if (rows[0] === undefined) throw new InvoiceError("invoice_not_found");
  return rows[0];
}

async function loadLines(
  transaction: OrganizationTransaction,
  organizationId: string,
  invoiceId: string,
): Promise<readonly InvoiceLineRecord[]> {
  const rows = await transaction<
    {
      position: number;
      description: string;
      quantity: string;
      unit_price_minor_units: string;
      tax_label: string | null;
      tax_minor_units: string;
      line_subtotal_minor_units: string;
    }[]
  >`
    SELECT position, description, quantity, unit_price_minor_units::text,
      tax_label, tax_minor_units::text, line_subtotal_minor_units::text
    FROM merchant_invoice_lines
    WHERE organization_id = ${organizationId}::uuid AND invoice_id = ${invoiceId}::uuid
    ORDER BY position
  `;
  return rows.map((row) => ({
    position: row.position,
    description: row.description,
    quantity: row.quantity,
    unitPriceMinorUnits: row.unit_price_minor_units,
    taxLabel: row.tax_label,
    taxMinorUnits: row.tax_minor_units,
    lineSubtotalMinorUnits: row.line_subtotal_minor_units,
  }));
}

async function insertLines(
  transaction: OrganizationTransaction,
  organizationId: string,
  invoiceId: string,
  lines: readonly CalculatedInvoiceLine[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await transaction`
      INSERT INTO merchant_invoice_lines (
        organization_id, invoice_id, position, description, quantity,
        unit_price_minor_units, tax_label, tax_minor_units,
        line_subtotal_minor_units
      ) VALUES (
        ${organizationId}::uuid, ${invoiceId}::uuid, ${index + 1},
        ${line.description}, ${line.quantity}, ${line.unitPriceMinorUnits},
        ${line.taxLabel}, ${line.taxMinorUnits}, ${line.lineSubtotalMinorUnits}
      )
    `;
  }
}

async function requireCustomer(
  transaction: OrganizationTransaction,
  organizationId: string,
  customerId: string,
): Promise<{ readonly id: string; readonly displayName: string }> {
  const rows = await transaction<{ id: string; display_name: string }[]>`
    SELECT id::text, display_name FROM customers
    WHERE organization_id = ${organizationId}::uuid
      AND id = ${customerId}::uuid AND disabled_at IS NULL
  `;
  if (rows[0] === undefined) throw new InvoiceError("customer_not_found");
  return { id: rows[0].id, displayName: rows[0].display_name };
}

async function requireWallet(
  transaction: OrganizationTransaction,
  organizationId: string,
  walletId: string,
  requireActive: boolean,
): Promise<readonly AssetSymbol[]> {
  const rows = await transaction<{ status: string; symbol: string | null }[]>`
    SELECT wallet.status, asset.symbol
    FROM merchant_wallets AS wallet
    LEFT JOIN merchant_wallet_assets AS asset
      ON asset.organization_id = wallet.organization_id AND asset.wallet_id = wallet.id
    WHERE wallet.organization_id = ${organizationId}::uuid AND wallet.id = ${walletId}::uuid
    ORDER BY asset.symbol
    FOR SHARE OF wallet
  `;
  if (rows.length === 0 || (requireActive && rows[0]?.status !== "active")) {
    throw new InvoiceError("settlement_wallet_not_found");
  }
  return rows.flatMap((row) =>
    row.symbol === null ? [] : [assetBySymbol(row.symbol).symbol],
  );
}

function toInvoice(
  row: InvoiceRow,
  lines: readonly InvoiceLineRecord[],
): InvoiceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    publicReference: row.public_reference,
    externalId: row.external_id,
    customerId: row.customer_id,
    settlementWalletId: row.settlement_wallet_id,
    acceptedAssetSymbols: row.accepted_asset_symbols,
    currency: parseCurrency(row.currency),
    status: row.status,
    subtotalMinorUnits: row.subtotal_minor_units,
    taxMinorUnits: row.tax_minor_units,
    totalMinorUnits: row.total_minor_units,
    dueAt: row.due_at.toISOString(),
    version: row.version,
    issuedAt: row.issued_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancellationReason: row.cancellation_reason,
    lines,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseCurrency(value: string): InvoiceCurrency {
  if (!(INVOICE_CURRENCIES as readonly string[]).includes(value)) {
    throw new InvoiceError("unsupported_invoice_currency");
  }
  return value as InvoiceCurrency;
}

function normalizeAssets(values: readonly string[]): readonly AssetSymbol[] {
  if (values.length < 1 || values.length > 2)
    throw new InvoiceError("invalid_invoice_assets");
  const symbols = [...new Set(values)]
    .sort()
    .map((value) => assetBySymbol(value).symbol);
  if (symbols.length !== values.length)
    throw new InvoiceError("invalid_invoice_assets");
  return symbols;
}

function normalizeExternalId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.normalize("NFC");
  if (
    [...normalized].length < 1 ||
    [...normalized].length > 128 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new InvoiceError("invalid_invoice_external_id");
  }
  return normalized;
}

async function auditIfRequested(
  transaction: OrganizationTransaction,
  input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key";
    readonly actorId: string;
    readonly auditRequestId?: string;
    readonly now: Date;
  },
  action: string,
  objectId: string,
  reasonCode: string,
): Promise<void> {
  if (input.auditRequestId === undefined) return;
  await appendAuditEvent(transaction, {
    organizationId: input.organizationId,
    actorKind: input.actorKind,
    actorId: input.actorId,
    action,
    objectKind: "invoice",
    objectId,
    requestId: input.auditRequestId,
    outcome: "succeeded",
    reasonCode,
    occurredAt: input.now,
  });
}

function validateDate(value: Date): void {
  if (!Number.isFinite(value.getTime()))
    throw new InvoiceError("invalid_invoice_time");
}

function mapInvoiceError(error: unknown): InvoiceError {
  const code = safeOwnCode(error);
  if (code === "23505") return new InvoiceError("invoice_external_id_conflict");
  if (
    code !== undefined &&
    (code.startsWith("invoice_") ||
      code.endsWith("_not_found") ||
      code === "invalid_cancellation_reason")
  ) {
    return new InvoiceError(code);
  }
  return new InvoiceError("invoice_store_unavailable", error);
}

function safeOwnCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
