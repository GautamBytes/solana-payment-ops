import { describe, expect, it, vi } from "vitest";
import { HttpSolanaAccountRpcPort } from "../src/index.js";

describe("HTTP Solana account RPC", () => {
  it("binds each response to its JSON-RPC request ID", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
        };
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "getSlot"
              ? 42
              : {
                  value: {
                    owner: "TokenProgram",
                    data: {
                      parsed: { info: { owner: "Wallet", mint: "Mint" } },
                    },
                  },
                },
        });
      });
    const rpc = new HttpSolanaAccountRpcPort({
      endpoint: "https://rpc.example.com",
      fetch,
    });
    await expect(rpc.getFinalizedHead()).resolves.toEqual({
      slot: 42n,
      signature: null,
    });
    await expect(rpc.getTokenAccount("TokenAccount")).resolves.toEqual({
      address: "TokenAccount",
      owner: "Wallet",
      mint: "Mint",
      programOwner: "TokenProgram",
    });
  });

  it("rejects mismatched IDs and oversized bodies with a bounded error", async () => {
    for (const response of [
      Response.json({ jsonrpc: "2.0", id: 999, result: 42 }),
      new Response("x".repeat(1_048_577), { status: 200 }),
    ]) {
      const rpc = new HttpSolanaAccountRpcPort({
        endpoint: "https://rpc.example.com",
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
      });
      await expect(rpc.getFinalizedHead()).rejects.toMatchObject({
        code: "invalid_solana_rpc_response",
        message: "Solana RPC request failed",
      });
    }
  });
});
