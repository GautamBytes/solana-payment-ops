import type { Metadata } from "next";

import { RoadmapPageContent } from "../../components/roadmap-page";

export const metadata: Metadata = {
  title: "Roadmap",
  description:
    "Review shipped PayOps capabilities, current engineering work, and proposed Solana public-good milestones.",
  robots: { index: true, follow: true },
};

export default function RoadmapPage() {
  return <RoadmapPageContent />;
}
