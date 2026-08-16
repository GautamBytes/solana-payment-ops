import { randomUUID } from "node:crypto";

import { analyzePublicWallet, HttpSolanaRpc } from "@payops/ingestion";

import { createEmbeddedPublicWalletAnalysisHandler } from "../../../lib/server/embedded-public-wallet-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const handler = createEmbeddedPublicWalletAnalysisHandler({
  isEnabled: () =>
    process.env.PAYOPS_EMBEDDED_PUBLIC_ANALYSIS_ENABLED === "true",
  analyze: analyzePublicWallet,
  rpcForRequest: (signal) =>
    new HttpSolanaRpc({
      cluster: "mainnet-beta",
      endpoint: publicRpcUrl(process.env.PAYOPS_PUBLIC_SOLANA_RPC_URL),
      timeoutMs: 20_000,
      signal,
    }),
  requestId: randomUUID,
});

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}

function publicRpcUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("missing public Solana RPC URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid public Solana RPC URL");
  }
  return url.toString();
}
