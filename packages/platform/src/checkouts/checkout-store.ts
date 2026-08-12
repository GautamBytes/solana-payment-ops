import postgres from "postgres";
import type { OrganizationDatabase } from "../db/organization-transaction.js";
import { buildSolanaPayUrl } from "../payments/attempt-service.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actorPattern = /^[\x21-\x7e]{1,128}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CheckoutRecord {
  readonly checkoutId: string;
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly publicNonce: Uint8Array;
  readonly derivationKeyId: string;
  readonly state: "active" | "revoked";
  readonly version: number;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface PublicCheckoutView {
  readonly schemaVersion: "0.1";
  readonly merchant: { readonly displayName: string };
  readonly invoice: {
    readonly publicReference: string;
    readonly currency: "USD" | "EUR" | "GBP" | "INR";
    readonly totalMinorUnits: string;
    readonly dueAt: string;
    readonly status: "issued" | "overdue" | "paid" | "exception";
  };
  readonly acceptedAssets: readonly {
    readonly symbol: "USDC" | "USDT";
    readonly mint: string;
    readonly decimals: 6;
  }[];
  readonly currentAttempt: PublicCheckoutAttempt | null;
}

export interface PublicCheckoutAttempt {
  readonly publicAttemptId: string;
  readonly assetSymbol: "USDC" | "USDT";
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

export type CheckoutStoreErrorCode =
  | "invalid_checkout"
  | "checkout_invoice_not_available"
  | "checkout_already_active"
  | "checkout_not_found"
  | "checkout_store_unavailable";

export class CheckoutStoreError extends Error {
  public constructor(
    readonly code: CheckoutStoreErrorCode,
    cause?: unknown,
  ) {
    super(
      "Checkout persistence failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "CheckoutStoreError";
  }
}

export class CheckoutStore {
  readonly #database: OrganizationDatabase;
  readonly #capabilities: postgres.Sql;

  public constructor(database: OrganizationDatabase, databaseUrl: string) {
    this.#database = database;
    this.#capabilities = postgres(databaseUrl, {
      max: 2,
      onnotice: () => undefined,
    });
  }

  public async create(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly invoiceId: string;
    readonly checkoutId: string;
    readonly publicNonce: Uint8Array;
    readonly derivationKeyId: string;
    readonly tokenDigest: string;
    readonly now: Date;
  }): Promise<CheckoutRecord> {
    validateCreate(input);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (sql) => {
          const invoice = await sql<{ id: string }[]>`
            SELECT id::text FROM merchant_invoices
            WHERE organization_id = ${input.organizationId}::uuid
              AND id = ${input.invoiceId}::uuid AND status = 'issued'
            FOR UPDATE
          `;
          if (invoice.length !== 1) {
            throw new CheckoutStoreError("checkout_invoice_not_available");
          }
          const rows = await sql<CheckoutRow[]>`
            INSERT INTO public_checkouts (
              id, organization_id, invoice_id, public_nonce,
              derivation_key_id, state, version, created_at
            ) VALUES (
              ${input.checkoutId}::uuid, ${input.organizationId}::uuid,
              ${input.invoiceId}::uuid, ${input.publicNonce},
              ${input.derivationKeyId}, 'active', 1,
              ${input.now.toISOString()}
            )
            RETURNING id::text, organization_id::text, invoice_id::text,
              public_nonce, derivation_key_id, state, version, created_at,
              revoked_at
          `;
          await sql`
            INSERT INTO public_checkout_capabilities (
              token_digest, organization_id, checkout_id, active, created_at
            ) VALUES (
              ${input.tokenDigest}, ${input.organizationId}::uuid,
              ${input.checkoutId}::uuid, true, ${input.now.toISOString()}
            )
          `;
          return toCheckout(rows[0]!);
        },
      );
    } catch (error) {
      if (error instanceof CheckoutStoreError) throw error;
      if (safeOwnCode(error) === "23505") {
        throw new CheckoutStoreError("checkout_already_active");
      }
      throw new CheckoutStoreError("checkout_store_unavailable", error);
    }
  }

  public async getActiveForInvoice(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly invoiceId: string;
  }): Promise<CheckoutRecord | null> {
    if (!uuidPattern.test(input.invoiceId)) return null;
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const rows = await sql<CheckoutRow[]>`
          SELECT id::text, organization_id::text, invoice_id::text,
            public_nonce, derivation_key_id, state, version, created_at,
            revoked_at
          FROM public_checkouts
          WHERE organization_id = ${input.organizationId}::uuid
            AND invoice_id = ${input.invoiceId}::uuid AND state = 'active'
        `;
        return rows[0] === undefined ? null : toCheckout(rows[0]);
      },
    );
  }

  public async resolve(
    tokenDigest: string,
    actorId: string,
  ): Promise<CheckoutRecord | null> {
    if (!digestPattern.test(tokenDigest) || !actorPattern.test(actorId))
      return null;
    const capability = await this.#capabilities<CapabilityRow[]>`
      SELECT organization_id::text, checkout_id::text
      FROM public_checkout_capabilities
      WHERE token_digest = ${tokenDigest} AND active
    `;
    const root = capability[0];
    if (root === undefined) return null;
    return this.#database.transaction(
      { organizationId: root.organization_id, actorId },
      async (sql) => {
        const rows = await sql<CheckoutRow[]>`
          SELECT c.id::text, c.organization_id::text, c.invoice_id::text,
            c.public_nonce, c.derivation_key_id, c.state, c.version,
            c.created_at, c.revoked_at
          FROM public_checkouts c
          JOIN merchant_invoices i
            ON i.organization_id = c.organization_id AND i.id = c.invoice_id
          WHERE c.organization_id = ${root.organization_id}::uuid
            AND c.id = ${root.checkout_id}::uuid
            AND c.state = 'active' AND i.status IN ('issued', 'paid')
        `;
        return rows[0] === undefined ? null : toCheckout(rows[0]);
      },
    );
  }

  public async revoke(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly checkoutId: string;
    readonly now: Date;
  }): Promise<void> {
    if (!uuidPattern.test(input.checkoutId) || !finiteDate(input.now)) {
      throw new CheckoutStoreError("invalid_checkout");
    }
    await this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const updated = await sql<{ id: string }[]>`
          UPDATE public_checkouts SET
            state = 'revoked', version = version + 1,
            revoked_at = ${input.now.toISOString()}
          WHERE organization_id = ${input.organizationId}::uuid
            AND id = ${input.checkoutId}::uuid AND state = 'active'
          RETURNING id::text
        `;
        if (updated.length !== 1)
          throw new CheckoutStoreError("checkout_not_found");
        await sql`
          UPDATE public_checkout_capabilities SET
            active = false, revoked_at = ${input.now.toISOString()}
          WHERE organization_id = ${input.organizationId}::uuid
            AND checkout_id = ${input.checkoutId}::uuid AND active
        `;
      },
    );
  }

  public async publicView(
    checkout: CheckoutRecord,
    now: Date,
  ): Promise<PublicCheckoutView | null> {
    if (!finiteDate(now) || checkout.state !== "active") return null;
    return this.#database.transaction(
      { organizationId: checkout.organizationId, actorId: "public-checkout" },
      async (sql) => {
        const roots = await sql<PublicCheckoutRootRow[]>`
          SELECT o.name AS merchant_name, i.public_reference, i.currency,
            i.total_minor_units::text, i.due_at, i.status AS invoice_status
          FROM public_checkouts c
          JOIN merchant_invoices i
            ON i.organization_id = c.organization_id AND i.id = c.invoice_id
          JOIN organization o ON o.id = c.organization_id
          WHERE c.organization_id = ${checkout.organizationId}::uuid
            AND c.id = ${checkout.checkoutId}::uuid AND c.state = 'active'
            AND i.id = ${checkout.invoiceId}::uuid
            AND i.status IN ('issued', 'paid')
        `;
        const root = roots[0];
        if (root === undefined) return null;
        const assets = await sql<PublicAssetRow[]>`
          SELECT a.symbol, a.mint, a.decimals
          FROM merchant_invoices i
          JOIN merchant_wallet_assets a
            ON a.organization_id = i.organization_id
              AND a.wallet_id = i.settlement_wallet_id
              AND a.symbol = ANY(i.accepted_asset_symbols)
          WHERE i.organization_id = ${checkout.organizationId}::uuid
            AND i.id = ${checkout.invoiceId}::uuid
          ORDER BY a.symbol
        `;
        const attempts = await sql<PublicAttemptRow[]>`
          SELECT a.public_attempt_id::text, a.asset_symbol, a.mint,
            a.recipient_address, a.reference_address, q.amount_tokens,
            q.amount_base_units::text, q.expires_at, p.public_status,
            p.updated_at
          FROM payment_attempts a
          JOIN payment_quotes q
            ON q.organization_id = a.organization_id AND q.attempt_id = a.id
          JOIN payment_projections p
            ON p.organization_id = a.organization_id AND p.attempt_id = a.id
          WHERE a.organization_id = ${checkout.organizationId}::uuid
            AND a.checkout_id = ${checkout.checkoutId}::uuid
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 1
        `;
        const attempt = attempts[0];
        return {
          schemaVersion: "0.1",
          merchant: { displayName: root.merchant_name },
          invoice: {
            publicReference: root.public_reference,
            currency: root.currency,
            totalMinorUnits: root.total_minor_units,
            dueAt: root.due_at.toISOString(),
            status:
              root.invoice_status === "paid"
                ? "paid"
                : attempt?.public_status === "exception"
                  ? "exception"
                  : root.due_at.getTime() < now.getTime()
                    ? "overdue"
                    : "issued",
          },
          acceptedAssets: assets.map(({ symbol, mint }) => ({
            symbol,
            mint,
            decimals: 6 as const,
          })),
          currentAttempt:
            attempt === undefined ? null : toPublicAttempt(attempt, root),
        };
      },
    );
  }

  public async close(): Promise<void> {
    await this.#capabilities.end();
  }
}

interface CheckoutRow {
  readonly id: string;
  readonly organization_id: string;
  readonly invoice_id: string;
  readonly public_nonce: Uint8Array;
  readonly derivation_key_id: string;
  readonly state: "active" | "revoked";
  readonly version: number;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
}

interface CapabilityRow {
  readonly organization_id: string;
  readonly checkout_id: string;
}

interface PublicCheckoutRootRow {
  readonly merchant_name: string;
  readonly public_reference: string;
  readonly currency: "USD" | "EUR" | "GBP" | "INR";
  readonly total_minor_units: string;
  readonly due_at: Date;
  readonly invoice_status: "issued" | "paid";
}

interface PublicAssetRow {
  readonly symbol: "USDC" | "USDT";
  readonly mint: string;
  readonly decimals: 6;
}

interface PublicAttemptRow {
  readonly public_attempt_id: string;
  readonly asset_symbol: "USDC" | "USDT";
  readonly mint: string;
  readonly recipient_address: string;
  readonly reference_address: string;
  readonly amount_tokens: string;
  readonly amount_base_units: string;
  readonly expires_at: Date;
  readonly public_status: PublicCheckoutAttempt["status"];
  readonly updated_at: Date;
}

function toPublicAttempt(
  attempt: PublicAttemptRow,
  root: PublicCheckoutRootRow,
): PublicCheckoutAttempt {
  return {
    publicAttemptId: attempt.public_attempt_id,
    assetSymbol: attempt.asset_symbol,
    mint: attempt.mint,
    amountTokens: attempt.amount_tokens,
    amountBaseUnits: attempt.amount_base_units,
    paymentUrl: buildSolanaPayUrl({
      recipient: attempt.recipient_address,
      mint: attempt.mint,
      reference: attempt.reference_address,
      amountTokens: attempt.amount_tokens,
      merchantName: root.merchant_name,
      invoiceReference: root.public_reference,
    }),
    reference: attempt.reference_address,
    quoteExpiresAt: attempt.expires_at.toISOString(),
    status: attempt.public_status,
    statusUpdatedAt: attempt.updated_at.toISOString(),
  };
}

function toCheckout(row: CheckoutRow): CheckoutRecord {
  if (row.public_nonce.byteLength !== 32)
    throw new CheckoutStoreError("checkout_store_unavailable");
  return {
    checkoutId: row.id,
    organizationId: row.organization_id,
    invoiceId: row.invoice_id,
    publicNonce: new Uint8Array(row.public_nonce),
    derivationKeyId: row.derivation_key_id,
    state: row.state,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function validateCreate(input: {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly checkoutId: string;
  readonly publicNonce: Uint8Array;
  readonly derivationKeyId: string;
  readonly tokenDigest: string;
  readonly now: Date;
}): void {
  if (
    !uuidPattern.test(input.organizationId) ||
    !uuidPattern.test(input.invoiceId) ||
    !uuidPattern.test(input.checkoutId) ||
    input.publicNonce.byteLength !== 32 ||
    !keyIdPattern.test(input.derivationKeyId) ||
    !digestPattern.test(input.tokenDigest) ||
    !finiteDate(input.now)
  ) {
    throw new CheckoutStoreError("invalid_checkout");
  }
}

function finiteDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
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
