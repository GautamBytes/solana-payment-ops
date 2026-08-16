import type { Metadata, Viewport } from "next";
import { TryWorkspaceView } from "../../components/try-workspace";
import { sampleWorkspace } from "../../lib/try/sample-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Try PayOps | Explore verified Solana payments",
  description:
    "Explore realistic sample invoices, verified payments, exceptions, and evidence without creating an account.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
  themeColor: "#050706",
};

export default function TryPage() {
  const publicApiOrigin =
    process.env.NEXT_PUBLIC_PAYOPS_API_ORIGIN ?? process.env.PAYOPS_API_ORIGIN;
  return (
    <TryWorkspaceView
      workspace={sampleWorkspace}
      publicWalletEnabled={
        process.env.PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED === "true"
      }
      {...(publicApiOrigin === undefined ? {} : { publicApiOrigin })}
    />
  );
}
