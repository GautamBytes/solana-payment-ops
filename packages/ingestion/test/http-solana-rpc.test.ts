import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PaymentFixtureSchema } from "@payops/core";
import { describe, expect, it } from "vitest";
import { HttpSolanaRpc, IngestionError } from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);
const address = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const signature =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

interface CapturedRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}

function fakeFetch(
  results: readonly unknown[],
  requests: CapturedRequest[],
): typeof fetch {
  let index = 0;
  return (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as CapturedRequest;
    requests.push(request);
    const result = results[index];
    index += 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: index, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function loadRpcResult(): Promise<Record<string, unknown>> {
  const fixture = PaymentFixtureSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  );
  const {
    cluster: _cluster,
    commitment: _commitment,
    signature: _signature,
    ...result
  } = fixture.rpcTransaction;
  return result;
}

describe("HttpSolanaRpc", () => {
  it("rejects plaintext non-local RPC endpoints", () => {
    expect(
      () =>
        new HttpSolanaRpc({
          cluster: "mainnet-beta",
          endpoint: "http://rpc.example",
        }),
    ).toThrow("RPC endpoint must use HTTPS unless it is local");
  });

  it("disables fetch redirects so HTTPS cannot downgrade", async () => {
    let redirect: RequestRedirect | undefined;
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async (_input, init) => {
        redirect = init?.redirect;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }),
          { status: 200 },
        );
      }) as typeof fetch,
    );

    await rpc.getSlot("confirmed");

    expect(redirect).toBe("error");
  });

  it("propagates worker cancellation to an active RPC request", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const rpc = new HttpSolanaRpc(
      {
        cluster: "mainnet-beta",
        endpoint: "https://rpc.invalid",
        signal: controller.signal,
      },
      (async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        });
      }) as typeof fetch,
    );

    const request = rpc.getSlot("confirmed");
    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: "rpc_transport_error",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("requests a stable captured address head", async () => {
    const requests: CapturedRequest[] = [];
    const rpc = new HttpSolanaRpc(
      {
        cluster: "mainnet-beta",
        endpoint: "https://rpc.invalid/?token=secret",
      },
      fakeFetch(
        [
          [
            {
              signature,
              slot: 345678901,
              blockTime: 1786000000,
              err: null,
              confirmationStatus: "confirmed",
            },
          ],
        ],
        requests,
      ),
    );

    const result = await rpc.getSignaturesForAddress({
      address,
      commitment: "confirmed",
      limit: 1,
    });

    expect(result[0]?.slot).toBe(345678901n);
    expect(requests[0]).toMatchObject({
      method: "getSignaturesForAddress",
      params: [address, { commitment: "confirmed", limit: 1 }],
    });
  });

  it.each([
    ["number", 42],
    ["boolean", false],
    ["array", ["InstructionError", 0]],
    ["empty string", ""],
  ])("rejects malformed status error type %s", async (_name, err) => {
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      fakeFetch(
        [
          {
            context: { slot: 345678901 },
            value: [{ slot: 345678901, err, confirmationStatus: "finalized" }],
          },
        ],
        [],
      ),
    );

    await expect(rpc.getSignatureStatuses([signature])).rejects.toMatchObject({
      code: "rpc_invalid_json",
      retryable: true,
    });
  });

  it("wraps and validates a transaction result", async () => {
    const requests: CapturedRequest[] = [];
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      fakeFetch([await loadRpcResult()], requests),
    );

    const result = await rpc.getTransaction(signature, "confirmed");

    expect(result).toMatchObject({
      cluster: "mainnet-beta",
      commitment: "confirmed",
      signature,
      slot: 345678901,
    });
    expect(requests[0]).toMatchObject({
      method: "getTransaction",
      params: [
        signature,
        {
          commitment: "confirmed",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        },
      ],
    });
  });

  it("rejects a response whose transaction signature differs", async () => {
    const transaction = await loadRpcResult();
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      fakeFetch([transaction], []),
    );

    await expect(
      rpc.getTransaction(
        "1111111111111111111111111111111111111111111111111111111111111111",
        "confirmed",
      ),
    ).rejects.toMatchObject({ code: "rpc_signature_conflict" });
  });

  it.each([
    ["an empty object", async () => ({})],
    [
      "a transaction without signatures",
      async () => {
        const result = await loadRpcResult();
        const transaction = result.transaction as Record<string, unknown>;
        delete transaction.signatures;
        return result;
      },
    ],
  ])("classifies %s as retryable malformed evidence", async (_name, result) => {
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      fakeFetch([await result()], []),
    );

    await expect(
      rpc.getTransaction(signature, "finalized"),
    ).rejects.toMatchObject({
      code: "rpc_transaction_schema_invalid",
      retryable: true,
    });
  });

  it("maps rate limiting without leaking the endpoint", async () => {
    const rpc = new HttpSolanaRpc(
      {
        cluster: "mainnet-beta",
        endpoint: "https://rpc.invalid/?token=super-secret",
      },
      (async () => new Response("limited", { status: 429 })) as typeof fetch,
    );

    const error = await rpc
      .getSlot("confirmed")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IngestionError);
    expect(error).toMatchObject({ code: "rpc_rate_limited", retryable: true });
    expect(String(error)).not.toContain("super-secret");
  });

  it.each([401, 403])(
    "treats HTTP %s as retryable so ingestion cannot skip evidence",
    async (status) => {
      const rpc = new HttpSolanaRpc(
        { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
        (async () => new Response("denied", { status })) as typeof fetch,
      );

      await expect(rpc.getSlot("confirmed")).rejects.toMatchObject({
        code: "rpc_transport_error",
        retryable: true,
      });
    },
  );

  it("classifies an unsupported transaction version as non-retryable", async () => {
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32015,
              message: "Transaction version (1) is not supported",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );

    await expect(
      rpc.getTransaction(signature, "confirmed"),
    ).rejects.toMatchObject({
      code: "rpc_unsupported_version",
      retryable: false,
    });
  });

  it("rejects an oversized declared response and cancels its body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-length": "999999999" },
        })) as typeof fetch,
    );

    await expect(rpc.getSlot("confirmed")).rejects.toMatchObject({
      code: "rpc_invalid_json",
      message: "Solana RPC response exceeded the size limit",
    });
    expect(cancelled).toBe(true);
  });

  it.each([
    ["depth", () => deeplyNestedEvidence(80)],
    [
      "node count",
      () => ({
        buckets: Array.from({ length: 13 }, () =>
          Array.from({ length: 4_000 }, () => 0),
        ),
      }),
    ],
    ["array length", () => Array.from({ length: 4_097 }, () => 0)],
    ["string bytes", () => "x".repeat(65_537)],
  ])("bounds status err evidence by %s", async (_name, err) => {
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      fakeFetch(
        [
          {
            context: { slot: 345678901 },
            value: [
              {
                slot: 345678901,
                err: err(),
                confirmationStatus: "finalized",
              },
            ],
          },
        ],
        [],
      ),
    );

    await expect(rpc.getSignatureStatuses([signature])).rejects.toMatchObject({
      code: "rpc_invalid_json",
      retryable: true,
    });
  });

  it("bounds chunked responses and cancels the reader on overflow", async () => {
    let cancelled = false;
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk < 2) {
          controller.enqueue(new Uint8Array(700_000));
          chunk += 1;
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async () => new Response(body, { status: 200 })) as typeof fetch,
    );

    await expect(rpc.getSlot("confirmed")).rejects.toMatchObject({
      code: "rpc_invalid_json",
      message: "Solana RPC response exceeded the size limit",
    });
    expect(cancelled).toBe(true);
  });

  it("cancels unread response data after malformed UTF-8", async () => {
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          controller.enqueue(new Uint8Array([0xff]));
          sent = true;
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const rpc = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async () => new Response(body, { status: 200 })) as typeof fetch,
    );

    await expect(rpc.getSlot("confirmed")).rejects.toMatchObject({
      code: "rpc_invalid_json",
      message: "Solana RPC returned invalid JSON",
    });
    expect(cancelled).toBe(true);
  });

  it.each([
    [
      "deeply nested evidence",
      (result: Record<string, unknown>) => {
        let nested: Record<string, unknown> = { value: "attacker-marker" };
        for (let depth = 0; depth < 80; depth += 1) nested = { nested };
        (result.meta as Record<string, unknown>).err = nested;
      },
    ],
    [
      "wide account dimensions",
      (result: Record<string, unknown>) => {
        const transaction = result.transaction as Record<string, unknown>;
        const message = transaction.message as Record<string, unknown>;
        message.accountKeys = Array.from({ length: 257 }, () => address);
      },
    ],
    [
      "oversized nested strings",
      (result: Record<string, unknown>) => {
        (result.meta as Record<string, unknown>).err = {
          detail: "attacker-marker".repeat(6_000),
        };
      },
    ],
  ])(
    "rejects %s before transaction canonicalization",
    async (_name, mutate) => {
      const result = await loadRpcResult();
      mutate(result);
      const rpc = new HttpSolanaRpc(
        { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
        fakeFetch([result], []),
      );

      const error = await rpc
        .getTransaction(signature, "finalized")
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "rpc_invalid_json",
        retryable: true,
        message: "Solana RPC transaction evidence exceeds safe limits",
      });
      expect(String(error)).not.toContain("attacker-marker");
    },
  );
});

function deeplyNestedEvidence(depth: number): Record<string, unknown> {
  let evidence: Record<string, unknown> = { value: "attacker-marker" };
  for (let index = 0; index < depth; index += 1) {
    evidence = { nested: evidence };
  }
  return evidence;
}
