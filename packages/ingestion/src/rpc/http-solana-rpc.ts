import { RpcTransactionEnvelopeSchema } from "@payops/core";
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

const addressSignatureSchema = z.object({
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  err: z.unknown().nullable(),
  confirmationStatus: z
    .enum(["processed", "confirmed", "finalized"])
    .nullable(),
});

const rawStatusSchema = z.object({
  slot: z.number().int().nonnegative(),
  err: z.unknown().nullable(),
  confirmationStatus: z
    .enum(["processed", "confirmed", "finalized"])
    .nullable(),
});

const statusResponseSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.array(rawStatusSchema.nullable()),
});

export interface HttpSolanaRpcConfig {
  readonly cluster: SolanaCluster;
  readonly endpoint: string;
  readonly timeoutMs?: number;
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
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new IngestionError(
        "rpc_transport_error",
        "Solana RPC request failed",
        { retryable: true, cause },
      );
    }

    if (response.status === 429) {
      throw new IngestionError("rpc_rate_limited", "Solana RPC rate limited", {
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new IngestionError(
        "rpc_transport_error",
        `Solana RPC returned HTTP ${response.status}`,
        { retryable: true },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
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
    const firstSignature =
      isRecord(raw) &&
      isRecord(raw.transaction) &&
      Array.isArray(raw.transaction.signatures)
        ? raw.transaction.signatures[0]
        : undefined;
    if (firstSignature !== signature) {
      throw new IngestionError(
        "rpc_signature_conflict",
        "RPC transaction signature does not match the request",
        { retryable: false },
      );
    }
    const parsed = RpcTransactionEnvelopeSchema.safeParse({
      ...(isRecord(raw) ? raw : {}),
      cluster: this.#cluster,
      commitment,
      signature,
    });
    if (!parsed.success) {
      throw new IngestionError(
        "rpc_transaction_schema_invalid",
        "Solana RPC returned an unsupported transaction structure",
        { retryable: false, cause: parsed.error },
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
