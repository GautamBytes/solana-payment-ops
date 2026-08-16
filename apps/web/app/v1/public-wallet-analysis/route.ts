import { randomUUID } from "node:crypto";

import { analyzePublicWallet, HttpSolanaRpc } from "@payops/ingestion";

import { createEmbeddedPublicWalletAnalysisHandler } from "../../../lib/server/embedded-public-wallet-analysis";
import { parseWebRuntimeConfig } from "../../../lib/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const handler = createEmbeddedPublicWalletAnalysisHandler({
  isEnabled: () => {
    try {
      return parseWebRuntimeConfig(process.env).mode === "embedded";
    } catch {
      return false;
    }
  },
  analyze: analyzePublicWallet,
  rpcForRequest: (signal) =>
    new HttpSolanaRpc({
      cluster: "mainnet-beta",
      endpoint: embeddedRpcUrl(),
      timeoutMs: 20_000,
      signal,
    }),
  requestId: randomUUID,
});

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}

function embeddedRpcUrl(): string {
  const config = parseWebRuntimeConfig(process.env);
  if (config.mode !== "embedded") {
    throw new Error("embedded public analysis is disabled");
  }
  return config.rpcUrl;
}
