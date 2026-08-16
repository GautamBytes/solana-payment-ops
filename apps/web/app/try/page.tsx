import type { Metadata } from "next";
import { TryWorkspaceView } from "../../components/try-workspace";
import { sampleWorkspace } from "../../lib/try/sample-workspace";

export const metadata: Metadata = {
  title: "Try PayOps — Explore verified Solana payments",
  description:
    "Explore realistic sample invoices, verified payments, exceptions, and evidence without creating an account.",
  robots: { index: true, follow: true },
};

export default function TryPage() {
  return (
    <TryWorkspaceView
      workspace={sampleWorkspace}
      publicWalletEnabled={
        process.env.PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED === "true"
      }
    />
  );
}
