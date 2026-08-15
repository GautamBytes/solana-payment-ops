import type { Metadata } from "next";
import { MarketingPage } from "../components/marketing-page";

export const metadata: Metadata = {
  title: "PayOps — Solana payment reconciliation for real businesses",
  description:
    "PayOps verifies finalized Solana USDC and USDT payments, matches them to invoices, and preserves accounting-ready evidence.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Know exactly which Solana payments got you paid.",
    description:
      "Verify finalized stablecoin payments, reconcile invoices, and keep replayable evidence with PayOps.",
    type: "website",
    siteName: "PayOps",
  },
};

export default function HomePage() {
  return <MarketingPage />;
}
