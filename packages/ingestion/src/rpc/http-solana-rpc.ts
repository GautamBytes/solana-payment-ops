import { RpcTransactionEnvelopeSchema } from "@payops/core/public-analysis";
import { z } from "zod";
import type {
  AddressSignature,
  Commitment,
  SignaturePageRequest,
  SolanaCluster,
  SolanaRpcPort,
  TransactionStatus,
} from "../domain/types.js";
import { IngestionError } from "../domain/types.js";

const transactionErrorSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
]);

const addressSignatureSchema = z.object({
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  err: transactionErrorSchema.nullable(),
  confirmationStatus: z
    .enum(["processed", "confirmed", "finalized"])
    .nullable(),
});

const rawStatusSchema = z.object({
  slot: z.number().int().nonnegative(),
  err: transactionErrorSchema.nullable(),
  confirmationStatus: z
    .enum(["processed", "confirmed", "finalized"])
    .nullable(),
});

const statusResponseSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.array(rawStatusSchema.nullable()),
});

const maxRpcResponseBytes = 1_048_576;
const maxEvidenceDepth = 32;
const maxEvidenceNodes = 50_000;
const maxEvidenceArrayLength = 4_096;
const maxEvidenceObjectProperties = 512;
const maxEvidenceStringBytes = 65_536;

export interface HttpSolanaRpcConfig {
  readonly cluster: SolanaCluster;
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function toRpcNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new IngestionError(
      "invalid_configuration",
      "RPC numeric value is outside JavaScript's safe integer range",
      { retryable: false },
    );
  }
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class HttpSolanaRpc implements SolanaRpcPort {
  readonly #cluster: SolanaCluster;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  #requestId = 0;

  public constructor(config: HttpSolanaRpcConfig, fetchImpl = fetch) {
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch (cause) {
      throw new IngestionError(
        "invalid_configuration",
        "RPC endpoint is not a valid URL",
        { retryable: false, cause },
      );
    }
    const local =
      endpoint.hostname === "localhost" ||
      endpoint.hostname.endsWith(".localhost") ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]";
    if (
      endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && local)
    ) {
      throw new IngestionError(
        "invalid_configuration",
        "RPC endpoint must use HTTPS unless it is local",
        { retryable: false },
      );
    }
    this.#endpoint = endpoint.toString();
    this.#cluster = config.cluster;
    this.#fetch = fetchImpl;
    this.#timeoutMs = config.timeoutMs ?? 20_000;
    this.#signal = config.signal;
  }

  async #call(method: string, params: readonly unknown[]): Promise<unknown> {
    this.#requestId += 1;
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.#requestId,
          method,
          params,
        }),
        redirect: "error",
        signal:
          this.#signal === undefined
            ? AbortSignal.timeout(this.#timeoutMs)
            : AbortSignal.any([
                this.#signal,
                AbortSignal.timeout(this.#timeoutMs),
              ]),
      });
    } catch (cause) {
      throw new IngestionError(
        "rpc_transport_error",
        "Solana RPC request failed",
        { retryable: true, cause },
      );
    }

    if (response.status === 429) {
      await cancelResponseBody(response);
      throw new IngestionError("rpc_rate_limited", "Solana RPC rate limited", {
        retryable: true,
      });
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new IngestionError(
        "rpc_transport_error",
        `Solana RPC returned HTTP ${response.status}`,
        { retryable: true },
      );
    }

    let body: unknown;
    try {
      body = await readBoundedJson(response);
    } catch (cause) {
      if (cause instanceof IngestionError) throw cause;
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC returned invalid JSON",
        { retryable: true, cause },
      );
    }
    if (!isRecord(body)) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC response is not an object",
        { retryable: true },
      );
    }
    if (body.error !== undefined) {
      const unsupportedVersion =
        isRecord(body.error) &&
        (body.error.code === -32015 ||
          (typeof body.error.message === "string" &&
            /transaction version.*not supported/i.test(body.error.message)));
      if (unsupportedVersion) {
        throw new IngestionError(
          "rpc_unsupported_version",
          "Solana RPC transaction version is not supported",
          { retryable: false },
        );
      }
      throw new IngestionError("rpc_error", "Solana RPC returned an error", {
        retryable: true,
      });
    }
    if (!("result" in body)) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC response has no result",
        { retryable: true },
      );
    }
    return body.result;
  }

  public async getSignaturesForAddress(
    request: SignaturePageRequest,
  ): Promise<readonly AddressSignature[]> {
    if (request.limit < 1 || request.limit > 1000) {
      throw new IngestionError(
        "invalid_configuration",
        "Signature page limit must be between 1 and 1000",
        { retryable: false },
      );
    }
    const options: Record<string, unknown> = {
      commitment: request.commitment,
      limit: request.limit,
    };
    if (request.before !== undefined) {
      options.before = request.before;
    }
    if (request.minContextSlot !== undefined) {
      options.minContextSlot = toRpcNumber(request.minContextSlot);
    }
    const parsed = z
      .array(addressSignatureSchema)
      .safeParse(
        await this.#call("getSignaturesForAddress", [request.address, options]),
      );
    if (!parsed.success) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC returned invalid address history",
        { retryable: true, cause: parsed.error },
      );
    }
    return parsed.data.map((entry) => ({
      ...entry,
      slot: BigInt(entry.slot),
      blockTime: entry.blockTime === null ? null : BigInt(entry.blockTime),
    }));
  }

  public async getTransaction(
    signature: string,
    commitment: Commitment,
  ): Promise<ReturnType<typeof RpcTransactionEnvelopeSchema.parse> | null> {
    const raw = await this.#call("getTransaction", [
      signature,
      {
        commitment,
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (raw === null) {
      return null;
    }
    if (!transactionEvidenceWithinLimits(raw)) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC transaction evidence exceeds safe limits",
        { retryable: true },
      );
    }
    const firstSignature =
      isRecord(raw) &&
      isRecord(raw.transaction) &&
      Array.isArray(raw.transaction.signatures) &&
      typeof raw.transaction.signatures[0] === "string"
        ? raw.transaction.signatures[0]
        : undefined;
    const parsed = RpcTransactionEnvelopeSchema.safeParse({
      ...(isRecord(raw) ? raw : {}),
      cluster: this.#cluster,
      commitment,
      signature: firstSignature ?? signature,
    });
    if (!parsed.success) {
      throw new IngestionError(
        "rpc_transaction_schema_invalid",
        "Solana RPC returned an unsupported transaction structure",
        { retryable: true, cause: parsed.error },
      );
    }
    if (firstSignature !== signature) {
      throw new IngestionError(
        "rpc_signature_conflict",
        "RPC transaction signature does not match the request",
        { retryable: false },
      );
    }
    return parsed.data;
  }

  public async getSignatureStatuses(
    signatures: readonly string[],
  ): Promise<readonly (TransactionStatus | null)[]> {
    if (signatures.length < 1 || signatures.length > 256) {
      throw new IngestionError(
        "invalid_configuration",
        "Signature status batch must contain between 1 and 256 signatures",
        { retryable: false },
      );
    }
    const parsed = statusResponseSchema.safeParse(
      await this.#call("getSignatureStatuses", [
        signatures,
        { searchTransactionHistory: true },
      ]),
    );
    if (!parsed.success || parsed.data.value.length !== signatures.length) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC returned invalid signature statuses",
        { retryable: true, cause: parsed.success ? undefined : parsed.error },
      );
    }
    if (
      parsed.data.value.some(
        (status) =>
          status !== null && !structuralEvidenceWithinLimits(status.err),
      )
    ) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC status evidence exceeds safe limits",
        { retryable: true },
      );
    }
    return parsed.data.value.map((status, index) => {
      if (status === null) {
        return null;
      }
      const requestedSignature = signatures[index];
      if (requestedSignature === undefined) {
        return null;
      }
      return {
        signature: requestedSignature,
        slot: BigInt(status.slot),
        confirmationStatus: status.confirmationStatus,
        err: status.err,
      };
    });
  }

  public async getSlot(commitment: Commitment): Promise<bigint> {
    const parsed = z
      .number()
      .int()
      .nonnegative()
      .safeParse(await this.#call("getSlot", [{ commitment }]));
    if (!parsed.success) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Solana RPC returned an invalid slot",
        { retryable: true, cause: parsed.error },
      );
    }
    return BigInt(parsed.data);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The bounded public error remains independent of cleanup failures.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = /^\d+$/.test(declaredLength)
      ? Number(declaredLength)
      : Number.NaN;
    if (!Number.isSafeInteger(length) || length > maxRpcResponseBytes) {
      await cancelResponseBody(response);
      throw oversizedRpcResponse();
    }
  }
  if (response.body === null) {
    throw new IngestionError(
      "rpc_invalid_json",
      "Solana RPC returned invalid JSON",
      { retryable: true },
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxRpcResponseBytes) {
        await reader.cancel();
        throw oversizedRpcResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The bounded parse error remains independent of cleanup failures.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function oversizedRpcResponse(): IngestionError {
  return new IngestionError(
    "rpc_invalid_json",
    "Solana RPC response exceeded the size limit",
    { retryable: true },
  );
}

function transactionEvidenceWithinLimits(value: unknown): boolean {
  if (!structuralEvidenceWithinLimits(value)) return false;

  if (!isRecord(value) || !isRecord(value.transaction)) return true;
  const transaction = value.transaction;
  if (arrayExceeds(transaction.signatures, 256)) return false;
  if (!isRecord(transaction.message)) return true;
  const message = transaction.message;
  if (
    arrayExceeds(message.accountKeys, 256) ||
    arrayExceeds(message.addressTableLookups, 256) ||
    arrayExceeds(message.instructions, 256)
  ) {
    return false;
  }
  if (instructionListExceeds(message.instructions)) return false;
  if (Array.isArray(message.addressTableLookups)) {
    for (const lookup of message.addressTableLookups) {
      if (
        isRecord(lookup) &&
        (arrayExceeds(lookup.writableIndexes, 256) ||
          arrayExceeds(lookup.readonlyIndexes, 256))
      ) {
        return false;
      }
    }
  }
  if (!isRecord(value.meta)) return true;
  const meta = value.meta;
  if (
    arrayExceeds(meta.innerInstructions, 256) ||
    arrayExceeds(meta.preTokenBalances, 256) ||
    arrayExceeds(meta.postTokenBalances, 256)
  ) {
    return false;
  }
  if (isRecord(meta.loadedAddresses)) {
    if (
      arrayExceeds(meta.loadedAddresses.writable, 256) ||
      arrayExceeds(meta.loadedAddresses.readonly, 256)
    ) {
      return false;
    }
  }
  if (Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      if (
        isRecord(group) &&
        (arrayExceeds(group.instructions, 256) ||
          instructionListExceeds(group.instructions))
      ) {
        return false;
      }
    }
  }
  return true;
}

function structuralEvidenceWithinLimits(value: unknown): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > maxEvidenceNodes || current.depth > maxEvidenceDepth) {
      return false;
    }
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > maxEvidenceStringBytes) {
        return false;
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const entries = Array.isArray(current.value)
      ? current.value
      : Object.entries(current.value).flatMap(([key, entry]) => [key, entry]);
    if (
      (Array.isArray(current.value) &&
        current.value.length > maxEvidenceArrayLength) ||
      (!Array.isArray(current.value) &&
        Object.keys(current.value).length > maxEvidenceObjectProperties)
    ) {
      return false;
    }
    for (const entry of entries) {
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return true;
}

function instructionListExceeds(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(
    (instruction) =>
      isRecord(instruction) &&
      (arrayExceeds(instruction.accounts, 256) ||
        (typeof instruction.data === "string" &&
          Buffer.byteLength(instruction.data, "utf8") > 2_048)),
  );
}

function arrayExceeds(value: unknown, maximum: number): boolean {
  return Array.isArray(value) && value.length > maximum;
}
