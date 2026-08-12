export type AssetSymbol = "USDC" | "USDT";
export type PublicPaymentStatus =
  | "awaiting_payment"
  | "detected"
  | "confirmed"
  | "finalized"
  | "paid"
  | "expired"
  | "confirmation_revoked"
  | "exception";

export interface PublicPaymentAttempt {
  readonly publicAttemptId: string;
  readonly assetSymbol: AssetSymbol;
  readonly mint: string;
  readonly amountTokens: string;
  readonly amountBaseUnits: string;
  readonly paymentUrl: string;
  readonly reference: string;
  readonly quoteExpiresAt: string;
  readonly status: PublicPaymentStatus;
  readonly statusUpdatedAt: string;
}

export interface PublicCheckout {
  readonly schemaVersion: "0.1";
  readonly merchant: { readonly displayName: string };
  readonly invoice: {
    readonly publicReference: string;
    readonly currency: "USD" | "EUR" | "GBP" | "INR";
    readonly totalMinorUnits: string;
    readonly dueAt: string;
    readonly status: "issued" | "overdue" | "partial" | "paid" | "exception";
  };
  readonly acceptedAssets: readonly {
    readonly symbol: AssetSymbol;
    readonly mint: string;
    readonly decimals: 6;
  }[];
  readonly currentAttempt: PublicPaymentAttempt | null;
}

export interface PublicStatus {
  readonly invoiceStatus: PublicCheckout["invoice"]["status"];
  readonly currentAttempt: PublicPaymentAttempt | null;
}

export async function fetchCheckout(
  token: string,
  apiOrigin: string,
): Promise<PublicCheckout | null> {
  assertToken(token);
  const response = await fetch(`${exactOrigin(apiOrigin)}/pay/${token}`, {
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("checkout_unavailable");
  return parseCheckout(await response.json());
}

export async function createPaymentAttempt(
  token: string,
  assetSymbol: AssetSymbol,
  idempotencyKey: string,
): Promise<PublicPaymentAttempt> {
  assertToken(token);
  if (!/^[\x21-\x7e]{16,128}$/.test(idempotencyKey)) {
    throw new Error("quote_unavailable");
  }
  const response = await fetch(`${clientApiOrigin()}/pay/${token}/quotes`, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ assetSymbol }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 409 ? "attempt_active" : "quote_unavailable",
    );
  return parseAttempt(await response.json());
}

export async function fetchPaymentStatus(
  token: string,
  etag: string | null,
): Promise<{
  readonly status: PublicStatus | null;
  readonly etag: string | null;
}> {
  assertToken(token);
  const response = await fetch(`${clientApiOrigin()}/pay/${token}/status`, {
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: {
      accept: "application/json",
      ...(etag === null ? {} : { "if-none-match": etag }),
    },
  });
  if (response.status === 304) return { status: null, etag };
  if (!response.ok) throw new Error("status_unavailable");
  return {
    status: parseStatus(await response.json()),
    etag: response.headers.get("etag"),
  };
}

export function checkoutTokenFromPath(pathname: string): string {
  const match = /^\/pay\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname);
  if (match?.[1] === undefined) throw new Error("checkout_not_found");
  assertToken(match[1]);
  return match[1];
}

export function formatMinorUnits(
  currency: PublicCheckout["invoice"]["currency"],
  minorUnits: string,
): string {
  if (!/^(0|[1-9][0-9]{0,37})$/.test(minorUnits)) return `${currency} —`;
  const value = BigInt(minorUnits);
  const major = value / 100n;
  const minor = (value % 100n).toString().padStart(2, "0");
  return `${currency} ${major.toLocaleString("en-IN")}.${minor}`;
}

function clientApiOrigin(): string {
  const value = process.env.NEXT_PUBLIC_PAYOPS_API_ORIGIN;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("checkout_unavailable");
  }
  return exactOrigin(value);
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error("checkout_unavailable");
  }
  return url.origin;
}

function assertToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("checkout_not_found");
}

function parseCheckout(value: unknown): PublicCheckout {
  const record = object(value);
  if (record.schemaVersion !== "0.1") throw new Error("checkout_unavailable");
  const merchant = object(record.merchant);
  const invoice = object(record.invoice);
  const assets = Array.isArray(record.acceptedAssets)
    ? record.acceptedAssets
    : [];
  if (
    !boundedText(merchant.displayName, 512) ||
    !boundedText(invoice.publicReference, 128) ||
    !isCurrency(invoice.currency) ||
    !isMinorUnits(invoice.totalMinorUnits) ||
    !isTimestamp(invoice.dueAt) ||
    !isInvoiceStatus(invoice.status) ||
    assets.length < 1 ||
    assets.length > 2
  )
    throw new Error("checkout_unavailable");
  const acceptedAssets = assets.map((asset) => {
    const entry = object(asset);
    if (
      !isAsset(entry.symbol) ||
      !boundedText(entry.mint, 64) ||
      entry.decimals !== 6
    ) {
      throw new Error("checkout_unavailable");
    }
    return { symbol: entry.symbol, mint: entry.mint, decimals: 6 as const };
  });
  return {
    schemaVersion: "0.1",
    merchant: { displayName: merchant.displayName },
    invoice: {
      publicReference: invoice.publicReference,
      currency: invoice.currency,
      totalMinorUnits: invoice.totalMinorUnits,
      dueAt: invoice.dueAt,
      status: invoice.status,
    },
    acceptedAssets,
    currentAttempt:
      record.currentAttempt === null
        ? null
        : parseAttempt(record.currentAttempt),
  };
}

function parseStatus(value: unknown): PublicStatus {
  const record = object(value);
  if (!isInvoiceStatus(record.invoiceStatus))
    throw new Error("status_unavailable");
  return {
    invoiceStatus: record.invoiceStatus,
    currentAttempt:
      record.currentAttempt === null
        ? null
        : parseAttempt(record.currentAttempt),
  };
}

function parseAttempt(value: unknown): PublicPaymentAttempt {
  const record = object(value);
  if (
    !isUuid(record.publicAttemptId) ||
    !isAsset(record.assetSymbol) ||
    !isSolanaAddress(record.mint) ||
    !isTokenAmount(record.amountTokens) ||
    !isBaseUnits(record.amountBaseUnits) ||
    !boundedText(record.paymentUrl, 2_048) ||
    !isSolanaAddress(record.reference) ||
    !isSolanaPayUrl(record.paymentUrl, {
      mint: record.mint,
      reference: record.reference,
      amountTokens: record.amountTokens,
    }) ||
    !isTimestamp(record.quoteExpiresAt) ||
    !isPaymentStatus(record.status) ||
    !isTimestamp(record.statusUpdatedAt)
  )
    throw new Error("checkout_unavailable");
  return record as unknown as PublicPaymentAttempt;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isSolanaAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  );
}

function isTokenAmount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})(\.[0-9]{1,6})?$/.test(value)
  );
}

function isMinorUnits(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,37})$/.test(value);
}

function isBaseUnits(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    return false;
  }
  return BigInt(value) <= 18_446_744_073_709_551_615n;
}

function isSolanaPayUrl(
  value: string,
  expected: {
    readonly mint: string;
    readonly reference: string;
    readonly amountTokens: string;
  },
): boolean {
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()].sort();
    return (
      url.protocol === "solana:" &&
      isSolanaAddress(url.pathname) &&
      url.hash === "" &&
      keys.join(",") === "amount,label,message,reference,spl-token" &&
      url.searchParams.getAll("amount").length === 1 &&
      url.searchParams.get("amount") === expected.amountTokens &&
      url.searchParams.getAll("spl-token").length === 1 &&
      url.searchParams.get("spl-token") === expected.mint &&
      url.searchParams.getAll("reference").length === 1 &&
      url.searchParams.get("reference") === expected.reference &&
      boundedText(url.searchParams.get("label"), 128) &&
      boundedText(url.searchParams.get("message"), 128)
    );
  } catch {
    return false;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("checkout_unavailable");
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= maximum
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isAsset(value: unknown): value is AssetSymbol {
  return value === "USDC" || value === "USDT";
}

function isCurrency(
  value: unknown,
): value is PublicCheckout["invoice"]["currency"] {
  return (
    value === "USD" || value === "EUR" || value === "GBP" || value === "INR"
  );
}

function isInvoiceStatus(
  value: unknown,
): value is PublicCheckout["invoice"]["status"] {
  return (
    value === "issued" ||
    value === "overdue" ||
    value === "partial" ||
    value === "paid" ||
    value === "exception"
  );
}

function isPaymentStatus(value: unknown): value is PublicPaymentStatus {
  return [
    "awaiting_payment",
    "detected",
    "confirmed",
    "finalized",
    "paid",
    "expired",
    "confirmation_revoked",
    "exception",
  ].includes(String(value));
}
