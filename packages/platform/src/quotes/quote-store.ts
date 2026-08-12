import { randomUUID } from "node:crypto";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import { evaluateQuoteInputs } from "./quote-policy.js";
import {
  calculateQuote,
  reproduceQuote,
  type QuoteCalculation,
} from "./quote-math.js";
import type { FiatObservation, StablecoinObservation } from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unsignedIntegerPattern = /^(0|[1-9][0-9]{0,19})$/;

export type QuoteStoreErrorCode =
  | "invalid_quote_request"
  | "quote_attempt_not_found"
  | "quote_attempt_not_open"
  | "quote_invoice_changed"
  | "quote_already_exists"
  | "corrupt_quote"
  | "quote_store_unavailable";

export class QuoteStoreError extends Error {
  public constructor(
    readonly code: QuoteStoreErrorCode,
    cause?: unknown,
  ) {
    super(
      "Quote persistence failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "QuoteStoreError";
  }
}

export interface StoredPaymentQuote extends QuoteCalculation {
  readonly id: string;
  readonly attemptId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuanceSlot: string;
}

export interface StoredQuoteBundle {
  readonly quote: StoredPaymentQuote;
  readonly stablecoinObservation: StablecoinObservation;
  readonly fiatObservation: FiatObservation | null;
}

export interface CreateQuoteInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly expectedInvoiceMinorUnits?: string;
  readonly stablecoinObservation: StablecoinObservation;
  readonly fiatObservation?: FiatObservation;
  readonly environment?: "production" | "test";
  readonly issuedAt: Date;
  readonly issuanceSlot: string;
}

export class QuoteStore {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async create(
    input: CreateQuoteInput & {
      readonly actorId: string;
    },
  ): Promise<StoredQuoteBundle> {
    validateRequest(input.attemptId, input.issuedAt, input.issuanceSlot);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        (sql) => createQuoteInTransaction(sql, input),
      );
    } catch (error) {
      if (error instanceof QuoteStoreError) throw error;
      if (safeOwnCode(error) === "23505")
        throw new QuoteStoreError("quote_already_exists");
      throw new QuoteStoreError("quote_store_unavailable", error);
    }
  }

  public async get(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly attemptId: string;
  }): Promise<StoredQuoteBundle | null> {
    if (!uuidPattern.test(input.attemptId)) return null;
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const rows = await sql<StoredQuoteRow[]>`
          SELECT q.id::text, q.attempt_id::text, q.formula_version,
            q.invoice_currency, q.invoice_minor_units::text, q.fiat_amount,
            q.usd_amount, q.stablecoin_usd_price, q.token_amount,
            q.amount_base_units::text, q.amount_tokens, q.input_digest,
            q.issued_at, q.expires_at, q.issuance_slot::text,
            s.source AS stable_source, s.symbol, s.price, s.confidence,
            s.exponent, s.publish_time, s.received_at AS stable_received_at,
            s.feed_id,
            s.raw_response_digest AS stable_raw_response_digest,
            f.source AS fiat_source, f.base_currency, f.rates,
            f.observed_for, f.published_at,
            f.received_at AS fiat_received_at, f.usage,
            f.raw_response_digest AS fiat_raw_response_digest
          FROM payment_quotes q
          JOIN quote_rate_observations s
            ON s.organization_id = q.organization_id
              AND s.id = q.stablecoin_observation_id
          LEFT JOIN quote_rate_observations f
            ON f.organization_id = q.organization_id
              AND f.id = q.fiat_observation_id
          WHERE q.organization_id = ${input.organizationId}::uuid
            AND q.attempt_id = ${input.attemptId}::uuid
        `;
        return rows[0] === undefined ? null : bundleFromRow(rows[0]);
      },
    );
  }
}

export async function createQuoteInTransaction(
  sql: OrganizationTransaction,
  input: CreateQuoteInput,
): Promise<StoredQuoteBundle> {
  validateRequest(input.attemptId, input.issuedAt, input.issuanceSlot);
  const attempts = await sql<AttemptInvoiceRow[]>`
    SELECT a.id::text AS attempt_id, a.asset_symbol, a.state,
      i.currency, i.total_minor_units::text, i.status AS invoice_status
    FROM payment_attempts a
    JOIN merchant_invoices i
      ON i.organization_id = a.organization_id AND i.id = a.invoice_id
    WHERE a.organization_id = ${input.organizationId}::uuid
      AND a.id = ${input.attemptId}::uuid
    FOR UPDATE OF a, i
  `;
  const attempt = attempts[0];
  if (attempt === undefined)
    throw new QuoteStoreError("quote_attempt_not_found");
  if (attempt.state !== "created" || attempt.invoice_status !== "issued") {
    throw new QuoteStoreError("quote_attempt_not_open");
  }
  if (
    attempt.asset_symbol !== input.stablecoinObservation.symbol ||
    (input.expectedInvoiceMinorUnits !== undefined &&
      input.expectedInvoiceMinorUnits !== attempt.total_minor_units)
  ) {
    throw new QuoteStoreError("quote_invoice_changed");
  }
  const policy = evaluateQuoteInputs({
    now: input.issuedAt,
    environment: input.environment ?? "production",
    currency: attempt.currency,
    primary: input.stablecoinObservation,
    fiat: input.fiatObservation,
  });
  const calculation = calculateQuote({
    invoiceCurrency: attempt.currency,
    invoiceMinorUnits: attempt.total_minor_units,
    stablecoinUsdPrice: policy.primary.price,
    fiatRates: policy.fiat?.rates,
  });
  const stablecoinObservationId = randomUUID();
  await insertStablecoinObservation(
    sql,
    input.organizationId,
    stablecoinObservationId,
    policy.primary,
  );
  let fiatObservationId: string | null = null;
  if (policy.fiat !== null) {
    fiatObservationId = randomUUID();
    await insertFiatObservation(
      sql,
      input.organizationId,
      fiatObservationId,
      policy.fiat,
    );
  }
  const quoteId = randomUUID();
  const issuedAt = input.issuedAt.toISOString();
  const expiresAt = new Date(
    input.issuedAt.getTime() + 15 * 60_000,
  ).toISOString();
  await sql`
    INSERT INTO payment_quotes (
      id, organization_id, attempt_id, stablecoin_observation_id,
      fiat_observation_id, formula_version, invoice_currency,
      invoice_minor_units, fiat_amount, usd_amount, stablecoin_usd_price,
      token_amount, amount_base_units, amount_tokens, input_digest, issued_at,
      expires_at, issuance_slot, created_at
    ) VALUES (
      ${quoteId}::uuid, ${input.organizationId}::uuid, ${input.attemptId}::uuid,
      ${stablecoinObservationId}::uuid, ${fiatObservationId}::uuid,
      ${calculation.formulaVersion}, ${calculation.invoiceCurrency},
      ${calculation.invoiceMinorUnits}, ${calculation.fiatAmount},
      ${calculation.usdAmount}, ${calculation.stablecoinUsdPrice},
      ${calculation.tokenAmount}, ${calculation.amountBaseUnits},
      ${calculation.amountTokens}, ${calculation.inputDigest}, ${issuedAt},
      ${expiresAt}, ${input.issuanceSlot}, ${issuedAt}
    )
  `;
  await sql`
    UPDATE payment_attempts SET
      state = 'quoted', version = version + 1, updated_at = ${issuedAt}
    WHERE organization_id = ${input.organizationId}::uuid
      AND id = ${input.attemptId}::uuid AND state = 'created'
  `;
  return {
    quote: {
      id: quoteId,
      attemptId: input.attemptId,
      ...calculation,
      issuedAt,
      expiresAt,
      issuanceSlot: input.issuanceSlot,
    },
    stablecoinObservation: policy.primary,
    fiatObservation: policy.fiat,
  };
}

async function insertStablecoinObservation(
  sql: import("postgres").TransactionSql,
  organizationId: string,
  id: string,
  observation: StablecoinObservation,
): Promise<void> {
  await sql`
    INSERT INTO quote_rate_observations (
      id, organization_id, observation_kind, source, symbol, price,
      confidence, exponent, publish_time, received_at, feed_id,
      raw_response_digest, created_at
    ) VALUES (
      ${id}::uuid, ${organizationId}::uuid, 'stablecoin',
      ${observation.source}, ${observation.symbol}, ${observation.price},
      ${observation.confidence}, ${observation.exponent},
      ${observation.publishTime}, ${observation.receivedAt},
      ${observation.feedId}, ${observation.rawResponseDigest},
      ${observation.receivedAt}
    )
  `;
}

async function insertFiatObservation(
  sql: import("postgres").TransactionSql,
  organizationId: string,
  id: string,
  observation: FiatObservation,
): Promise<void> {
  await sql`
    INSERT INTO quote_rate_observations (
      id, organization_id, observation_kind, source, received_at,
      base_currency, rates, observed_for, published_at, usage,
      raw_response_digest, created_at
    ) VALUES (
      ${id}::uuid, ${organizationId}::uuid, 'fiat', ${observation.source},
      ${observation.receivedAt}, ${observation.base},
      ${sql.json(observation.rates)}, ${observation.observedFor},
      ${observation.publishedAt}, ${observation.usage},
      ${observation.rawResponseDigest},
      ${observation.receivedAt}
    )
  `;
}

function bundleFromRow(row: StoredQuoteRow): StoredQuoteBundle {
  const stablecoinObservation: StablecoinObservation = {
    source: row.stable_source,
    symbol: row.symbol,
    price: row.price,
    confidence: row.confidence,
    exponent: row.exponent,
    publishTime: row.publish_time.toISOString(),
    feedId: row.feed_id,
    receivedAt: row.stable_received_at.toISOString(),
    rawResponseDigest: row.stable_raw_response_digest,
  };
  const fiatObservation = fiatFromRow(row);
  let reproduced: QuoteCalculation;
  try {
    reproduced = reproduceQuote(
      {
        invoiceCurrency: row.invoice_currency,
        invoiceMinorUnits: row.invoice_minor_units,
        stablecoinUsdPrice: row.stablecoin_usd_price,
        fiatRates: fiatObservation?.rates,
      },
      row.input_digest,
    );
  } catch (error) {
    throw new QuoteStoreError("corrupt_quote", error);
  }
  if (
    row.formula_version !== reproduced.formulaVersion ||
    row.fiat_amount !== reproduced.fiatAmount ||
    row.usd_amount !== reproduced.usdAmount ||
    row.token_amount !== reproduced.tokenAmount ||
    row.amount_base_units !== reproduced.amountBaseUnits ||
    row.amount_tokens !== reproduced.amountTokens
  ) {
    throw new QuoteStoreError("corrupt_quote");
  }
  return {
    quote: {
      id: row.id,
      attemptId: row.attempt_id,
      ...reproduced,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      issuanceSlot: row.issuance_slot,
    },
    stablecoinObservation,
    fiatObservation,
  };
}

function fiatFromRow(row: StoredQuoteRow): FiatObservation | null {
  if (row.fiat_source === null) return null;
  if (
    row.base_currency !== "EUR" ||
    row.rates === null ||
    typeof row.rates !== "object" ||
    Array.isArray(row.rates) ||
    row.observed_for === null ||
    row.published_at === null ||
    row.fiat_received_at === null ||
    row.usage === null ||
    row.fiat_raw_response_digest === null
  ) {
    throw new QuoteStoreError("corrupt_quote");
  }
  const rates = row.rates as Record<string, unknown>;
  if (
    typeof rates.USD !== "string" ||
    typeof rates.GBP !== "string" ||
    typeof rates.INR !== "string"
  ) {
    throw new QuoteStoreError("corrupt_quote");
  }
  return {
    source: row.fiat_source,
    base: "EUR",
    rates: { USD: rates.USD, GBP: rates.GBP, INR: rates.INR },
    observedFor: dateOnly(row.observed_for),
    publishedAt: row.published_at.toISOString(),
    receivedAt: row.fiat_received_at.toISOString(),
    usage: row.usage,
    rawResponseDigest: row.fiat_raw_response_digest,
  };
}

interface AttemptInvoiceRow {
  readonly attempt_id: string;
  readonly asset_symbol: "USDC" | "USDT";
  readonly state: string;
  readonly currency: "USD" | "EUR" | "GBP" | "INR";
  readonly total_minor_units: string;
  readonly invoice_status: string;
}

interface StoredQuoteRow {
  readonly id: string;
  readonly attempt_id: string;
  readonly formula_version: string;
  readonly invoice_currency: "USD" | "EUR" | "GBP" | "INR";
  readonly invoice_minor_units: string;
  readonly fiat_amount: string;
  readonly usd_amount: string;
  readonly stablecoin_usd_price: string;
  readonly token_amount: string;
  readonly amount_base_units: string;
  readonly amount_tokens: string;
  readonly input_digest: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly issuance_slot: string;
  readonly stable_source: StablecoinObservation["source"];
  readonly symbol: "USDC" | "USDT";
  readonly price: string;
  readonly confidence: string;
  readonly exponent: number;
  readonly publish_time: Date;
  readonly stable_received_at: Date;
  readonly feed_id: string;
  readonly stable_raw_response_digest: string;
  readonly fiat_source: FiatObservation["source"] | null;
  readonly base_currency: "EUR" | null;
  readonly rates: unknown;
  readonly observed_for: string | Date | null;
  readonly published_at: Date | null;
  readonly fiat_received_at: Date | null;
  readonly usage: FiatObservation["usage"] | null;
  readonly fiat_raw_response_digest: string | null;
}

function validateRequest(
  attemptId: string,
  issuedAt: Date,
  slot: string,
): void {
  if (
    !uuidPattern.test(attemptId) ||
    !Number.isFinite(issuedAt.getTime()) ||
    !unsignedIntegerPattern.test(slot) ||
    BigInt(slot) > 18_446_744_073_709_551_615n
  ) {
    throw new QuoteStoreError("invalid_quote_request");
  }
}

function dateOnly(value: string | Date): string {
  return typeof value === "string"
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
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
