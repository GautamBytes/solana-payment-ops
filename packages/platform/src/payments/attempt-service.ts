import { randomUUID } from "node:crypto";
import { address, generateKeyPairSigner } from "@solana/kit";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import { assetBySymbol, type AssetSymbol } from "../wallets/asset-registry.js";
import type { FinalizedHead } from "../wallets/rpc-port.js";
import { createQuoteInTransaction } from "../quotes/quote-store.js";
import type { FiatRatePort, StablecoinPricePort } from "../quotes/types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const providerPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const idempotencyKeyPattern = /^[\x21-\x7e]{16,128}$/;

export interface QuoteHeadPort {
  getFinalizedHead(signal: AbortSignal): Promise<FinalizedHead>;
}

export interface PublicPaymentAttempt {
  readonly publicAttemptId: string;
  readonly assetSymbol: AssetSymbol;
  readonly mint: string;
  readonly amountTokens: string;
  readonly amountBaseUnits: string;
  readonly paymentUrl: string;
  readonly reference: string;
  readonly quoteExpiresAt: string;
  readonly status:
    | "awaiting_payment"
    | "detected"
    | "confirmed"
    | "finalized"
    | "paid"
    | "expired"
    | "confirmation_revoked"
    | "exception";
  readonly statusUpdatedAt: string;
}

export type PaymentAttemptErrorCode =
  | "invalid_payment_attempt"
  | "payment_checkout_not_available"
  | "payment_asset_not_available"
  | "payment_attempt_already_active"
  | "payment_attempt_idempotency_conflict"
  | "payment_attempt_unavailable";

export class PaymentAttemptError extends Error {
  public constructor(
    readonly code: PaymentAttemptErrorCode,
    cause?: unknown,
  ) {
    super(
      "Payment attempt could not be created",
      cause === undefined ? undefined : { cause },
    );
    this.name = "PaymentAttemptError";
  }
}

export class PaymentAttemptService {
  readonly #database: OrganizationDatabase;
  readonly #providerId: string;
  readonly #environment: "production" | "test";
  readonly #stablecoinPrices: StablecoinPricePort;
  readonly #fiatRates: FiatRatePort | undefined;
  readonly #quoteHead: QuoteHeadPort;

  public constructor(input: {
    readonly database: OrganizationDatabase;
    readonly providerId: string;
    readonly environment: "production" | "test";
    readonly stablecoinPrices: StablecoinPricePort;
    readonly fiatRates?: FiatRatePort;
    readonly quoteHead: QuoteHeadPort;
  }) {
    if (!providerPattern.test(input.providerId)) {
      throw new PaymentAttemptError("invalid_payment_attempt");
    }
    this.#database = input.database;
    this.#providerId = input.providerId;
    this.#environment = input.environment;
    this.#stablecoinPrices = input.stablecoinPrices;
    this.#fiatRates = input.fiatRates;
    this.#quoteHead = input.quoteHead;
  }

  public async create(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly checkoutId: string;
    readonly assetSymbol: AssetSymbol;
    readonly idempotencyKey: string;
    readonly now: Date;
    readonly signal: AbortSignal;
  }): Promise<PublicPaymentAttempt> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.checkoutId) ||
      !idempotencyKeyPattern.test(input.idempotencyKey) ||
      !Number.isFinite(input.now.getTime()) ||
      (input.assetSymbol !== "USDC" && input.assetSymbol !== "USDT")
    ) {
      throw new PaymentAttemptError("invalid_payment_attempt");
    }
    try {
      return await this.#create(input);
    } catch (error) {
      const code = safeOwnCode(error);
      if (isPaymentAttemptCode(code)) throw new PaymentAttemptError(code);
      if (code === "23505") {
        throw new PaymentAttemptError("payment_attempt_already_active");
      }
      throw new PaymentAttemptError("payment_attempt_unavailable", error);
    }
  }

  async #create(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly checkoutId: string;
    readonly assetSymbol: AssetSymbol;
    readonly idempotencyKey: string;
    readonly now: Date;
    readonly signal: AbortSignal;
  }): Promise<PublicPaymentAttempt> {
    const replay = await this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      (sql) => findIdempotentAttempt(sql, input),
    );
    if (replay !== null) return replay;
    const preview = await this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const rows = await sql<CheckoutPreviewRow[]>`
          SELECT i.currency, i.total_minor_units::text
          FROM public_checkouts c
          JOIN merchant_invoices i
            ON i.organization_id = c.organization_id AND i.id = c.invoice_id
          WHERE c.organization_id = ${input.organizationId}::uuid
            AND c.id = ${input.checkoutId}::uuid AND c.state = 'active'
            AND i.status = 'issued'
        `;
        return rows[0];
      },
    );
    if (preview === undefined)
      throw new PaymentAttemptError("payment_checkout_not_available");
    const stablecoinObservation = await this.#stablecoinPrices.observe(
      input.assetSymbol,
      input.signal,
    );
    const fiatObservation =
      preview.currency === "USD"
        ? undefined
        : await this.#requiredFiatRates().observe(
            preview.currency,
            input.signal,
          );
    const head = await this.#quoteHead.getFinalizedHead(input.signal);
    if (head.slot < 0n || head.slot > 18_446_744_073_709_551_615n) {
      throw new PaymentAttemptError("payment_attempt_unavailable");
    }
    const referenceAddress = await generateReferenceAddress();
    const attemptId = randomUUID();
    const publicAttemptId = randomUUID();
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const root = await lockPaymentRoot(
          sql,
          input.organizationId,
          input.checkoutId,
          input.assetSymbol,
        );
        if (root === undefined)
          throw new PaymentAttemptError("payment_checkout_not_available");
        const replay = await findIdempotentAttempt(sql, input);
        if (replay !== null) return replay;
        if (!root.accepted_asset_symbols.includes(input.assetSymbol)) {
          throw new PaymentAttemptError("payment_asset_not_available");
        }
        const asset = assetBySymbol(input.assetSymbol);
        if (root.mint !== asset.mint || root.decimals !== asset.decimals) {
          throw new PaymentAttemptError("payment_asset_not_available");
        }
        validateSolanaRoot(root, referenceAddress);
        const now = input.now.toISOString();
        await sql`
          INSERT INTO payment_attempts (
            id, public_attempt_id, organization_id, invoice_id, checkout_id,
            asset_symbol, reference_address, recipient_address, mint,
            recipient_token_account, state, version, created_at, updated_at
          ) VALUES (
            ${attemptId}::uuid, ${publicAttemptId}::uuid,
            ${input.organizationId}::uuid, ${root.invoice_id}::uuid,
            ${input.checkoutId}::uuid, ${input.assetSymbol},
            ${referenceAddress}, ${root.recipient_address}, ${root.mint},
            ${root.recipient_token_account}, 'created', 1, ${now}, ${now}
          )
        `;
        const quote = await createQuoteInTransaction(sql, {
          organizationId: input.organizationId,
          attemptId,
          expectedInvoiceMinorUnits: preview.total_minor_units,
          stablecoinObservation,
          ...(fiatObservation === undefined ? {} : { fiatObservation }),
          environment: this.#environment,
          issuedAt: input.now,
          issuanceSlot: head.slot.toString(),
        });
        const paymentUrl = buildSolanaPayUrl({
          recipient: root.recipient_address,
          mint: root.mint,
          reference: referenceAddress,
          amountTokens: quote.quote.amountTokens,
          merchantName: root.merchant_name,
          invoiceReference: root.public_reference,
        });
        await requireRecipientWatch(
          sql,
          input.organizationId,
          this.#providerId,
          root.recipient_token_account,
        );
        await sql`
          INSERT INTO hosted_payment_expectations (
            organization_id, attempt_id, invoice_id, reference_address,
            recipient_token_account, mint, amount_base_units,
            quote_expires_at, latest_qualifying_at, active, created_at
          ) VALUES (
            ${input.organizationId}::uuid, ${attemptId}::uuid,
            ${root.invoice_id}::uuid, ${referenceAddress},
            ${root.recipient_token_account}, ${root.mint},
            ${quote.quote.amountBaseUnits}, ${quote.quote.expiresAt},
            ${new Date(new Date(quote.quote.expiresAt).getTime() + 90_000).toISOString()},
            true, ${now}
          )
        `;
        await sql`
          INSERT INTO watch_targets (
            id, provider_id, cluster, address, cutover_slot, cutover_signature,
            overlap_slots, committed_head_slot, committed_head_signature,
            coverage, active, created_at, organization_id
          ) VALUES (
            ${`payment-attempt:${attemptId}:reference`}, ${this.#providerId},
            'mainnet-beta', ${referenceAddress}, ${head.slot.toString()},
            ${head.signature}, 64, ${head.slot.toString()}, ${head.signature},
            'complete', true, ${now}, ${input.organizationId}::uuid
          )
        `;
        await sql`
          UPDATE payment_attempts SET
            state = 'awaiting_payment', version = version + 1,
            idempotency_key = ${input.idempotencyKey},
            payment_url = ${paymentUrl}, updated_at = ${now}
          WHERE organization_id = ${input.organizationId}::uuid
            AND id = ${attemptId}::uuid AND state = 'quoted'
        `;
        await sql`
          INSERT INTO payment_projections (
            organization_id, attempt_id, invoice_id, public_status,
            source_state, version, updated_at
          ) VALUES (
            ${input.organizationId}::uuid, ${attemptId}::uuid,
            ${root.invoice_id}::uuid, 'awaiting_payment',
            'awaiting_payment', 1, ${now}
          )
        `;
        await sql`
          INSERT INTO payment_status_history (
            id, organization_id, attempt_id, source_version, from_status,
            to_status, reason_code, occurred_at, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${input.organizationId}::uuid,
            ${attemptId}::uuid, 1, null, 'awaiting_payment',
            'quote_created', ${now}, ${now}
          )
        `;
        return {
          publicAttemptId,
          assetSymbol: input.assetSymbol,
          mint: root.mint,
          amountTokens: quote.quote.amountTokens,
          amountBaseUnits: quote.quote.amountBaseUnits,
          paymentUrl,
          reference: referenceAddress,
          quoteExpiresAt: quote.quote.expiresAt,
          status: "awaiting_payment",
          statusUpdatedAt: now,
        };
      },
    );
  }

  #requiredFiatRates(): FiatRatePort {
    if (this.#fiatRates === undefined) {
      throw new PaymentAttemptError("payment_attempt_unavailable");
    }
    return this.#fiatRates;
  }
}

interface CheckoutPreviewRow {
  readonly currency: "USD" | "EUR" | "GBP" | "INR";
  readonly total_minor_units: string;
}

interface PaymentRootRow {
  readonly invoice_id: string;
  readonly public_reference: string;
  readonly accepted_asset_symbols: readonly string[];
  readonly recipient_address: string;
  readonly mint: string;
  readonly recipient_token_account: string;
  readonly decimals: number;
  readonly merchant_name: string;
}

interface IdempotentAttemptRow {
  readonly public_attempt_id: string;
  readonly asset_symbol: AssetSymbol;
  readonly mint: string;
  readonly amount_tokens: string;
  readonly amount_base_units: string;
  readonly payment_url: string;
  readonly reference_address: string;
  readonly expires_at: Date;
  readonly public_status: PublicPaymentAttempt["status"];
  readonly updated_at: Date;
}

async function findIdempotentAttempt(
  sql: OrganizationTransaction,
  input: {
    readonly organizationId: string;
    readonly checkoutId: string;
    readonly assetSymbol: AssetSymbol;
    readonly idempotencyKey: string;
  },
): Promise<PublicPaymentAttempt | null> {
  const rows = await sql<IdempotentAttemptRow[]>`
    SELECT a.public_attempt_id::text, a.asset_symbol, a.mint,
      q.amount_tokens, q.amount_base_units::text, a.payment_url,
      a.reference_address, q.expires_at, p.public_status, p.updated_at
    FROM payment_attempts a
    JOIN payment_quotes q
      ON q.organization_id = a.organization_id AND q.attempt_id = a.id
    JOIN payment_projections p
      ON p.organization_id = a.organization_id AND p.attempt_id = a.id
    WHERE a.organization_id = ${input.organizationId}::uuid
      AND a.checkout_id = ${input.checkoutId}::uuid
      AND a.idempotency_key = ${input.idempotencyKey}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  if (row.asset_symbol !== input.assetSymbol) {
    throw new PaymentAttemptError("payment_attempt_idempotency_conflict");
  }
  return {
    publicAttemptId: row.public_attempt_id,
    assetSymbol: row.asset_symbol,
    mint: row.mint,
    amountTokens: row.amount_tokens,
    amountBaseUnits: row.amount_base_units,
    paymentUrl: row.payment_url,
    reference: row.reference_address,
    quoteExpiresAt: row.expires_at.toISOString(),
    status: row.public_status,
    statusUpdatedAt: row.updated_at.toISOString(),
  };
}

async function lockPaymentRoot(
  sql: OrganizationTransaction,
  organizationId: string,
  checkoutId: string,
  symbol: AssetSymbol,
): Promise<PaymentRootRow | undefined> {
  const rows = await sql<PaymentRootRow[]>`
    SELECT i.id::text AS invoice_id, i.public_reference,
      i.accepted_asset_symbols, w.address AS recipient_address,
      a.mint, a.token_account AS recipient_token_account, a.decimals,
      o.name AS merchant_name
    FROM public_checkouts c
    JOIN merchant_invoices i
      ON i.organization_id = c.organization_id AND i.id = c.invoice_id
    JOIN merchant_wallets w
      ON w.organization_id = i.organization_id
        AND w.id = i.settlement_wallet_id
    JOIN merchant_wallet_assets a
      ON a.organization_id = w.organization_id AND a.wallet_id = w.id
        AND a.symbol = ${symbol}
    JOIN organization o ON o.id = i.organization_id
    WHERE c.organization_id = ${organizationId}::uuid
      AND c.id = ${checkoutId}::uuid AND c.state = 'active'
      AND i.status = 'issued' AND w.status = 'active'
    FOR UPDATE OF c, i, w, a
  `;
  return rows[0];
}

async function requireRecipientWatch(
  sql: OrganizationTransaction,
  organizationId: string,
  providerId: string,
  addressValue: string,
): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT target.id FROM watch_targets target
    JOIN rpc_providers provider ON provider.id = target.provider_id
    WHERE target.organization_id = ${organizationId}::uuid
      AND target.provider_id = ${providerId}
      AND target.cluster = 'mainnet-beta'
      AND target.address = ${addressValue} AND target.active
      AND provider.active
    FOR SHARE
  `;
  if (rows.length !== 1)
    throw new PaymentAttemptError("payment_attempt_unavailable");
}

function validateSolanaRoot(
  root: PaymentRootRow,
  referenceAddress: string,
): void {
  try {
    address(root.recipient_address);
    address(root.mint);
    address(root.recipient_token_account);
    address(referenceAddress);
  } catch {
    throw new PaymentAttemptError("payment_asset_not_available");
  }
}

export function buildSolanaPayUrl(input: {
  readonly recipient: string;
  readonly mint: string;
  readonly reference: string;
  readonly amountTokens: string;
  readonly merchantName: string;
  readonly invoiceReference: string;
}): string {
  const merchantName = boundedLabel(input.merchantName);
  const invoiceReference = boundedLabel(input.invoiceReference);
  const url = new URL(`solana:${input.recipient}`);
  url.searchParams.set("amount", input.amountTokens);
  url.searchParams.set("spl-token", input.mint);
  url.searchParams.set("reference", input.reference);
  url.searchParams.set("label", merchantName);
  url.searchParams.set("message", `Invoice ${invoiceReference}`);
  return url.toString();
}

function boundedLabel(value: string): string {
  const normalized = value.normalize("NFC");
  if (
    [...normalized].length < 1 ||
    [...normalized].length > 64 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new PaymentAttemptError("payment_attempt_unavailable");
  }
  return normalized;
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

function isPaymentAttemptCode(
  code: string | undefined,
): code is PaymentAttemptErrorCode {
  return (
    code === "invalid_payment_attempt" ||
    code === "payment_checkout_not_available" ||
    code === "payment_asset_not_available" ||
    code === "payment_attempt_already_active" ||
    code === "payment_attempt_idempotency_conflict" ||
    code === "payment_attempt_unavailable"
  );
}

async function generateReferenceAddress(): Promise<string> {
  const signer = await generateKeyPairSigner();
  return String(signer.address);
}
