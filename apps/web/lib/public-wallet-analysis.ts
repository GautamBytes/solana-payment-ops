export type PublicAssetSymbol = "USDC" | "USDT";
export type PublicExpectationStatus =
  "not_provided" | "partial" | "matched" | "not_matched";
export type PublicWalletClientErrorCode =
  "invalid_request" | "rate_limited" | "unavailable" | "invalid_response";

export interface PublicWalletAnalysisRequest {
  readonly walletAddress: string;
  readonly rangeDays: 7 | 30;
  readonly expectation?: {
    readonly assetSymbol?: PublicAssetSymbol;
    readonly amountTokens?: string;
    readonly recipient?: string;
    readonly reference?: string;
  };
}

export interface PublicExpectationCheck {
  readonly field: "asset" | "amount" | "recipient" | "reference";
  readonly passed: boolean;
}

export interface PublicWalletTransfer {
  readonly signature: string;
  readonly slot: string;
  readonly blockTime: string;
  readonly assetSymbol: PublicAssetSymbol;
  readonly mint: string;
  readonly amountBaseUnits: string;
  readonly amountTokens: string;
  readonly sourceTokenAccount: string;
  readonly destinationTokenAccount: string;
  readonly references: readonly string[];
  readonly expectationStatus: PublicExpectationStatus;
  readonly expectationChecks: readonly PublicExpectationCheck[];
}

export interface PublicWalletAnalysis {
  readonly schemaVersion: "0.1";
  readonly walletAddress: string;
  readonly fromTime: string;
  readonly throughTime: string;
  readonly coverage: "complete" | "partial";
  readonly transfers: readonly PublicWalletTransfer[];
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]+$/;
const integerPattern = /^(0|[1-9][0-9]*)$/;
const amountPattern = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const fields = [
  "walletAddress",
  "rangeDays",
  "assetSymbol",
  "amountTokens",
  "recipient",
  "reference",
] as const;

export class PublicWalletClientError extends Error {
  public constructor(
    readonly code: PublicWalletClientErrorCode,
    options: {
      readonly requestId?: string;
      readonly field?: (typeof fields)[number];
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super("Public wallet analysis failed");
    this.name = "PublicWalletClientError";
    this.requestId = options.requestId;
    this.field = options.field;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  public readonly requestId: string | undefined;
  public readonly field: (typeof fields)[number] | undefined;
  public readonly retryAfterSeconds: number | undefined;

  public static async fromResponse(
    response: Response,
  ): Promise<PublicWalletClientError> {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfter !== null && /^[1-9][0-9]{0,4}$/.test(retryAfter)
        ? Number(retryAfter)
        : undefined;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const safe = safeErrorBody(body);
    const options = {
      ...(safe.requestId === undefined ? {} : { requestId: safe.requestId }),
      ...(safe.field === undefined ? {} : { field: safe.field }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
    if (response.status === 400) {
      return new PublicWalletClientError("invalid_request", options);
    }
    if (response.status === 429) {
      return new PublicWalletClientError("rate_limited", options);
    }
    return new PublicWalletClientError("unavailable", options);
  }
}

export async function analyzeWallet(
  input: PublicWalletAnalysisRequest,
  apiOrigin = process.env.NEXT_PUBLIC_PAYOPS_API_ORIGIN,
): Promise<PublicWalletAnalysis> {
  let response: Response;
  try {
    const endpoint =
      apiOrigin === undefined
        ? "/v1/public-wallet-analysis"
        : `${exactApiOrigin(apiOrigin)}/v1/public/wallet-analysis`;
    response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new PublicWalletClientError("unavailable");
  }
  if (!response.ok) throw await PublicWalletClientError.fromResponse(response);

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new PublicWalletClientError("invalid_response");
  }
  const analysis = parsePublicWalletAnalysis(raw);
  const rangeDays =
    (Date.parse(analysis.throughTime) - Date.parse(analysis.fromTime)) /
    86_400_000;
  if (
    analysis.walletAddress !== input.walletAddress ||
    rangeDays !== input.rangeDays
  ) {
    throw new PublicWalletClientError("invalid_response");
  }
  return analysis;
}

export function parsePublicWalletAnalysis(
  value: unknown,
): PublicWalletAnalysis {
  try {
    const analysis = strictRecord(value, [
      "schemaVersion",
      "walletAddress",
      "fromTime",
      "throughTime",
      "coverage",
      "transfers",
    ]);
    if (
      analysis.schemaVersion !== "0.1" ||
      !isPublicSolanaAddress(analysis.walletAddress) ||
      !isTimestamp(analysis.fromTime) ||
      !isTimestamp(analysis.throughTime) ||
      (analysis.coverage !== "complete" && analysis.coverage !== "partial") ||
      !Array.isArray(analysis.transfers) ||
      analysis.transfers.length > 100
    ) {
      throw new Error("invalid analysis");
    }
    const rangeDays =
      (Date.parse(analysis.throughTime) - Date.parse(analysis.fromTime)) /
      86_400_000;
    if (rangeDays !== 7 && rangeDays !== 30) {
      throw new Error("invalid range");
    }
    return {
      schemaVersion: "0.1",
      walletAddress: analysis.walletAddress,
      fromTime: analysis.fromTime,
      throughTime: analysis.throughTime,
      coverage: analysis.coverage,
      transfers: analysis.transfers.map(parseTransfer),
    };
  } catch (error) {
    if (error instanceof PublicWalletClientError) throw error;
    throw new PublicWalletClientError("invalid_response");
  }
}

export function isPublicSolanaAddress(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 44 ||
    !base58Pattern.test(value)
  ) {
    return false;
  }
  let number = 0n;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) return false;
    number = number * 58n + BigInt(index);
  }
  let bytes = 0;
  for (let current = number; current > 0n; current >>= 8n) bytes += 1;
  const leadingZeroBytes = value.length - value.replace(/^1+/, "").length;
  return bytes + leadingZeroBytes === 32;
}

export function isPublicAmount(value: string): boolean {
  return (
    /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/.test(value) && value.length <= 25
  );
}

function parseTransfer(value: unknown): PublicWalletTransfer {
  const transfer = strictRecord(value, [
    "signature",
    "slot",
    "blockTime",
    "assetSymbol",
    "mint",
    "amountBaseUnits",
    "amountTokens",
    "sourceTokenAccount",
    "destinationTokenAccount",
    "references",
    "expectationStatus",
    "expectationChecks",
  ]);
  if (
    !boundedBase58(transfer.signature, 64, 128) ||
    !boundedIntegerString(transfer.slot, 30) ||
    !isTimestamp(transfer.blockTime) ||
    (transfer.assetSymbol !== "USDC" && transfer.assetSymbol !== "USDT") ||
    !isPublicSolanaAddress(transfer.mint) ||
    !boundedIntegerString(transfer.amountBaseUnits, 40) ||
    typeof transfer.amountTokens !== "string" ||
    transfer.amountTokens.length > 48 ||
    !amountPattern.test(transfer.amountTokens) ||
    !isPublicSolanaAddress(transfer.sourceTokenAccount) ||
    !isPublicSolanaAddress(transfer.destinationTokenAccount) ||
    !Array.isArray(transfer.references) ||
    transfer.references.length > 16 ||
    !transfer.references.every(isPublicSolanaAddress) ||
    !["not_provided", "partial", "matched", "not_matched"].includes(
      String(transfer.expectationStatus),
    ) ||
    !Array.isArray(transfer.expectationChecks) ||
    transfer.expectationChecks.length > 4
  ) {
    throw new Error("invalid transfer");
  }
  const checks = transfer.expectationChecks.map(parseCheck);
  if (new Set(checks.map(({ field }) => field)).size !== checks.length) {
    throw new Error("duplicate expectation check");
  }
  return {
    signature: transfer.signature,
    slot: transfer.slot,
    blockTime: transfer.blockTime,
    assetSymbol: transfer.assetSymbol,
    mint: transfer.mint,
    amountBaseUnits: transfer.amountBaseUnits,
    amountTokens: transfer.amountTokens,
    sourceTokenAccount: transfer.sourceTokenAccount,
    destinationTokenAccount: transfer.destinationTokenAccount,
    references: transfer.references,
    expectationStatus: transfer.expectationStatus as PublicExpectationStatus,
    expectationChecks: checks,
  };
}

function parseCheck(value: unknown): PublicExpectationCheck {
  const check = strictRecord(value, ["field", "passed"]);
  if (
    !["asset", "amount", "recipient", "reference"].includes(
      String(check.field),
    ) ||
    typeof check.passed !== "boolean"
  ) {
    throw new Error("invalid expectation check");
  }
  return {
    field: check.field as PublicExpectationCheck["field"],
    passed: check.passed,
  };
}

function strictRecord(
  value: unknown,
  exactKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected record");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== exactKeys.length ||
    keys.some((key) => !exactKeys.includes(key))
  ) {
    throw new Error("unexpected response keys");
  }
  return record;
}

function isTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedBase58(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    base58Pattern.test(value)
  );
}

function boundedIntegerString(
  value: unknown,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    integerPattern.test(value)
  );
}

function exactApiOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error("missing API origin");
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new Error("unsafe API origin");
  }
  return url.origin;
}

function safeErrorBody(value: unknown): {
  readonly requestId?: string;
  readonly field?: (typeof fields)[number];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const requestId =
    typeof record.requestId === "string" && uuidPattern.test(record.requestId)
      ? record.requestId
      : undefined;
  const details =
    record.details !== null &&
    typeof record.details === "object" &&
    !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  const field = fields.find((candidate) => candidate === details?.field);
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(field === undefined ? {} : { field }),
  };
}
