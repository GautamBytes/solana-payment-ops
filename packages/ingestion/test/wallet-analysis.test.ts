import fixture from "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json" with { type: "json" };
import { RpcTransactionEnvelopeSchema } from "@payops/core";
import { describe, expect, it } from "vitest";

import type { AddressSignature, SolanaRpcPort } from "../src/domain/types.js";
import { analyzePublicWallet } from "../src/public-analysis/wallet-analysis.js";

const walletAddress = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";
const usdcTokenAccount = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const signature = fixture.rpcTransaction.signature;
const blockTime = BigInt(fixture.rpcTransaction.blockTime);
const transaction = RpcTransactionEnvelopeSchema.parse(fixture.rpcTransaction);

function signatureEntry(
  value: string,
  overrides: Partial<AddressSignature> = {},
): AddressSignature {
  return {
    signature: value,
    slot: 345_678_901n,
    blockTime,
    err: null,
    confirmationStatus: "finalized",
    ...overrides,
  };
}

function createRpc(
  entries: readonly AddressSignature[],
  transactionResult = transaction,
): SolanaRpcPort {
  return {
    async getSignaturesForAddress(request) {
      return request.before === undefined ? entries : [];
    },
    async getTransaction(requestedSignature) {
      return requestedSignature === signature ? transactionResult : null;
    },
    async getSignatureStatuses() {
      return [];
    },
    async getSlot() {
      return 345_678_999n;
    },
  };
}

function input() {
  return {
    walletAddress,
    watchedTokenAccounts: [
      { assetSymbol: "USDC" as const, address: usdcTokenAccount },
    ],
    fromTime: new Date((Number(blockTime) - 60) * 1_000),
    throughTime: new Date((Number(blockTime) + 60) * 1_000),
  };
}

const limits = {
  maxSignatures: 200,
  maxTransactions: 100,
  concurrency: 4,
};

describe("analyzePublicWallet", () => {
  it("returns finalized supported transfers without implying reconciliation", async () => {
    const result = await analyzePublicWallet(input(), {
      rpc: createRpc([signatureEntry(signature)]),
      ...limits,
    });

    expect(result.coverage).toBe("complete");
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      assetSymbol: "USDC",
      amountBaseUnits: "12500000",
      amountTokens: "12.5",
      expectationStatus: "not_provided",
      expectationChecks: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/invoice|paid|reconciled/i);
  });

  it("marks a transfer matched only when all four expectations pass", async () => {
    const result = await analyzePublicWallet(
      {
        ...input(),
        expectation: {
          assetSymbol: "USDC",
          amountBaseUnits: "12500000",
          destinationTokenAccount: usdcTokenAccount,
          reference: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
        },
      },
      { rpc: createRpc([signatureEntry(signature)]), ...limits },
    );

    expect(result.transfers[0]?.expectationStatus).toBe("matched");
    expect(result.transfers[0]?.expectationChecks).toEqual([
      { field: "asset", passed: true },
      { field: "amount", passed: true },
      { field: "recipient", passed: true },
      { field: "reference", passed: true },
    ]);
  });

  it("reports partial coverage when the signature cap is reached", async () => {
    const result = await analyzePublicWallet(input(), {
      rpc: createRpc([
        signatureEntry(signature),
        signatureEntry("signature-2"),
        signatureEntry("signature-3"),
      ]),
      maxSignatures: 2,
      maxTransactions: 2,
      concurrency: 1,
    });

    expect(result.coverage).toBe("partial");
  });

  it("bounds references and transfers in the public response", async () => {
    const originalInstruction =
      transaction.transaction.message.instructions[0]!;
    const boundedTransaction = RpcTransactionEnvelopeSchema.parse({
      ...transaction,
      transaction: {
        ...transaction.transaction,
        message: {
          ...transaction.transaction.message,
          instructions: Array.from({ length: 101 }, () => ({
            ...originalInstruction,
            accounts: [
              ...originalInstruction.accounts,
              ...Array.from({ length: 20 }, () => 5),
            ],
          })),
        },
      },
    });

    const result = await analyzePublicWallet(input(), {
      rpc: createRpc([signatureEntry(signature)], boundedTransaction),
      ...limits,
    });

    expect(result.coverage).toBe("partial");
    expect(result.transfers).toHaveLength(100);
    expect(
      result.transfers.every((item) => item.references.length === 16),
    ).toBe(true);
  });
});
