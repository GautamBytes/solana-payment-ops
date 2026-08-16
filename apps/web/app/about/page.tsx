import type { Metadata } from "next";

import { AboutPageContent } from "../../components/about-page";

export const metadata: Metadata = {
  title: "About PayOps | Open Solana payment infrastructure",
  description:
    "Learn why PayOps publishes deterministic Solana stablecoin payment verification, conformance fixtures, and replayable evidence.",
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  return <AboutPageContent />;
}
