import type { Metadata } from "next";
import {
  ArrowRight,
  BracketsCurly,
  CirclesFour,
  Lightning,
  ShieldCheck,
} from "@phosphor-icons/react/ssr";
import { docPages } from "../../components/docs-content";
import { DocsShell } from "../../components/docs-shell";

export const metadata: Metadata = {
  title: "PayOps documentation — Build reliable Solana payment operations",
  description:
    "Integrate deterministic Solana payment reconciliation, signed lifecycle events, evidence, and merchant APIs with PayOps.",
  robots: { index: true, follow: true },
};

const featured = [
  { slug: "integration", icon: <Lightning />, note: "Connect your product" },
  {
    slug: "architecture",
    icon: <CirclesFour />,
    note: "Understand the pipeline",
  },
  { slug: "lifecycle", icon: <BracketsCurly />, note: "Consume signed events" },
  { slug: "security", icon: <ShieldCheck />, note: "Review the boundaries" },
] as const;

export default function DocsPage() {
  return (
    <DocsShell>
      <section className="docs-hero">
        <p className="docs-kicker">PayOps documentation</p>
        <h1>Build reliable Solana payment operations.</h1>
        <p>
          Everything you need to detect finalized stablecoin transfers, match
          the right invoice, deliver signed events, and keep evidence your
          finance team can trust.
        </p>
        <div className="docs-hero-actions">
          <a href="/docs/quickstart">
            Start reconciling <ArrowRight size={18} aria-hidden="true" />
          </a>
          <code>npm install @payops/sdk</code>
        </div>
      </section>
      <section className="docs-feature-grid" aria-label="Featured guides">
        {featured.map((item) => {
          const page = docPages.find(
            (candidate) => candidate.slug === item.slug,
          )!;
          return (
            <a href={`/docs/${page.slug}`} key={page.slug}>
              <span aria-hidden="true">{item.icon}</span>
              <small>{item.note}</small>
              <h2>{page.label}</h2>
              <p>{page.summary}</p>
              <em>
                Read guide <ArrowRight size={15} aria-hidden="true" />
              </em>
            </a>
          );
        })}
      </section>
      <section className="docs-all-guides">
        <div>
          <p className="docs-kicker">All guides</p>
          <h2>From first transfer to production operations.</h2>
        </div>
        <div>
          {docPages.map((page, index) => (
            <a href={`/docs/${page.slug}`} key={page.slug}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{page.label}</strong>
              <small>{page.readingTime}</small>
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>
    </DocsShell>
  );
}
