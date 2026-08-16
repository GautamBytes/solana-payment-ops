import {
  ArrowRight,
  CheckCircle,
  Circle,
  Clock,
} from "@phosphor-icons/react/ssr";

import { MarketingHeader } from "./marketing-header";
import { MarketingFooter } from "./marketing-page";

const roadmapIssueUrl =
  "https://github.com/GautamBytes/solana-payment-ops/issues?q=is%3Aissue+label%3Aroadmap";

const columns = [
  {
    className: "shipped",
    eyebrow: "Available now",
    title: "Shipped",
    icon: CheckCircle,
    items: [
      "Deterministic USDC and USDT verification",
      "Twenty-five public conformance cases",
      "Seven published npm packages",
      "Signed lifecycle webhooks and replayable evidence",
      "Self-serve sample and public-wallet inspection",
      "Hosted readiness checks, recovery runbooks, and structured logs",
    ],
  },
  {
    className: "in-progress",
    eyebrow: "Active work",
    title: "In progress",
    icon: Clock,
    items: [
      "Backup restore and incident drill evidence",
      "Independent public integrations",
    ],
  },
  {
    className: "proposed",
    eyebrow: "Funding scope",
    title: "Proposed grant milestones",
    icon: Circle,
    items: [
      "Token-2022 verification and conformance",
      "Three maintained reference integrations",
      "Independent security review",
      "Stable v0.2 release",
    ],
  },
] as const;

export function RoadmapPageContent() {
  return (
    <div className="marketing trust-page" id="top">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <MarketingHeader homeHref="/" sectionHrefPrefix="/" />
      <main id="main-content" tabIndex={-1}>
        <section className="trust-page-hero" aria-labelledby="roadmap-title">
          <p className="eyebrow">Public roadmap</p>
          <h1 id="roadmap-title">
            What exists, what is active, what funding unlocks.
          </h1>
          <p>
            This roadmap separates shipped evidence from current engineering
            work and proposed grant milestones. Items move only when a public
            release, issue, test artifact, or integration proves the change.
          </p>
          <a className="button button-secondary" href={roadmapIssueUrl}>
            Review roadmap issues
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>

        <section className="roadmap-grid" aria-label="PayOps delivery roadmap">
          {columns.map((column) => {
            const Icon = column.icon;
            return (
              <article className={column.className} key={column.title}>
                <div className="roadmap-column-heading">
                  <span aria-hidden="true">
                    <Icon size={21} weight="fill" />
                  </span>
                  <div>
                    <p>{column.eyebrow}</p>
                    <h2>{column.title}</h2>
                  </div>
                </div>
                <ul>
                  {column.items.map((item) => (
                    <li key={item}>
                      <a href={roadmapIssueUrl}>
                        <span>{item}</span>
                        <ArrowRight size={15} aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
