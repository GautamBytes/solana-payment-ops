import type {
  FinalizedHead,
  SolanaAccountRpcPort,
  TokenAccountState,
} from "./rpc-port.js";

export class SolanaRpcError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(
      "Solana RPC request failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "SolanaRpcError";
    this.code = code;
  }
}

export class HttpSolanaAccountRpcPort implements SolanaAccountRpcPort {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #requestId = 0;

  public constructor(options: {
    readonly endpoint: string;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  }) {
    this.#endpoint = exactHttpsUrl(options.endpoint);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > 30_000
    ) {
      throw new SolanaRpcError("invalid_solana_rpc_configuration");
    }
  }

  public async getTokenAccount(
    address: string,
  ): Promise<TokenAccountState | null> {
    const value = await this.#call("getAccountInfo", [
      address,
      { encoding: "jsonParsed", commitment: "finalized" },
    ]);
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value))
      throw invalidResponse();
    const account = value as Record<string, unknown>;
    if (typeof account.owner !== "string") throw invalidResponse();
    const data = account.data;
    if (data === null || typeof data !== "object" || Array.isArray(data))
      throw invalidResponse();
    const parsed = (data as Record<string, unknown>).parsed;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw invalidResponse();
    const info = (parsed as Record<string, unknown>).info;
    if (info === null || typeof info !== "object" || Array.isArray(info))
      throw invalidResponse();
    const fields = info as Record<string, unknown>;
    if (typeof fields.owner !== "string" || typeof fields.mint !== "string") {
      throw invalidResponse();
    }
    return {
      address,
      owner: fields.owner,
      mint: fields.mint,
      programOwner: account.owner,
    };
  }

  public async getFinalizedHead(): Promise<FinalizedHead> {
    const value = await this.#call("getSlot", [{ commitment: "finalized" }]);
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw invalidResponse();
    return { slot: BigInt(value as number), signature: null };
  }

  async #call(method: string, params: readonly unknown[]): Promise<unknown> {
    try {
      const requestId = ++this.#requestId;
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params,
        }),
      });
      if (response.status !== 200)
        throw new SolanaRpcError("solana_rpc_unavailable");
      const text = await boundedText(response, 1_048_576);
      const parsed: unknown = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw invalidResponse();
      }
      const record = parsed as Record<string, unknown>;
      if (
        record.jsonrpc !== "2.0" ||
        record.id !== requestId ||
        record.error !== undefined ||
        !("result" in record)
      )
        throw invalidResponse();
      const result = record.result;
      if (method === "getAccountInfo") {
        if (
          result === null ||
          typeof result !== "object" ||
          Array.isArray(result)
        ) {
          throw invalidResponse();
        }
        return (result as Record<string, unknown>).value;
      }
      return result;
    } catch (error) {
      if (safeOwnCode(error) === "invalid_solana_rpc_response") {
        throw invalidResponse();
      }
      throw new SolanaRpcError("solana_rpc_unavailable", error);
    }
  }
}

async function boundedText(
  response: Response,
  maximum: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw invalidResponse();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw invalidResponse();
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalidResponse();
    }
  } finally {
    reader.releaseLock();
  }
}

function exactHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error("unsafe URL");
    }
    return url.toString();
  } catch {
    throw new SolanaRpcError("invalid_solana_rpc_configuration");
  }
}

function invalidResponse(): SolanaRpcError {
  return new SolanaRpcError("invalid_solana_rpc_response");
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
