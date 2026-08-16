import type { Metadata } from "next";
import {
  ArrowRight,
  BracketsCurly,
  CirclesFour,
  Coins,
  Database,
  Lightning,
  ShieldCheck,
  Storefront,
  Wrench,
} from "@phosphor-icons/react/ssr";
import { docPages } from "../../components/docs-content";
import { DocsShell } from "../../components/docs-shell";

export const metadata: Metadata = {
  title: "PayOps documentation | Build reliable Solana payment operations",
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

const audiences = [
  {
    icon: <Storefront />,
    title: "Merchant and finance teams",
    body: "Replace wallet-explorer searches and spreadsheet matching with a durable answer for every invoice: paid, still open, or waiting for review.",
    outcomes: [
      "Accounting-ready evidence",
      "Explicit exception ownership",
      "USDC and USDT settlement visibility",
    ],
  },
  {
    icon: <Coins />,
    title: "Product and backend teams",
    body: "Give checkout, order, customer, and notification workflows one signed payment event instead of making every service interpret chain data.",
    outcomes: [
      "Typed merchant API and SDK",
      "Versioned lifecycle events",
      "Idempotent payment decisions",
    ],
  },
  {
    icon: <Wrench />,
    title: "Infrastructure and operations teams",
    body: "Operate a read-only pipeline with replayable parsing, transactional decisions, bounded delivery retries, and inspectable production controls.",
    outcomes: [
      "Durable PostgreSQL workflows",
      "Fail-closed reconciliation",
      "Observable retries and review queues",
    ],
  },
] as const;

const truthFlow = [
  {
    step: "01",
    title: "Define what payment should look like",
    body: "Issue an invoice with the supported mint, settlement recipient, exact integer amount, reference, and expiry.",
  },
  {
    step: "02",
    title: "Observe finalized public chain facts",
    body: "Read the Solana transaction without custody or signing authority and preserve the canonical transfer representation.",
  },
  {
    step: "03",
    title: "Make one deterministic decision",
    body: "Compare immutable expectations with finalized facts. Exact matches become paid; uncertainty becomes an exception.",
  },
  {
    step: "04",
    title: "Persist evidence before notifying systems",
    body: "Store the decision and evidence atomically, then deliver the exact signed lifecycle event with bounded retries.",
  },
] as const;

const totalReadingMinutes = docPages.reduce(
  (total, page) => total + Number.parseInt(page.readingTime, 10),
  0,
);

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
      <section className="docs-problem" aria-labelledby="docs-problem-title">
        <div className="docs-section-intro">
          <p className="docs-kicker">The aim</p>
          <h2 id="docs-problem-title">What PayOps is trying to fix</h2>
        </div>
        <div className="docs-problem-copy">
          <p>
            Receiving a stablecoin transfer is easy. The difficult part is
            proving what that payment was for with enough confidence to update
            an invoice, release an order, and satisfy finance.
          </p>
          <p>
            Wallet activity does not carry your complete business context. Teams
            often compare signatures, recipients, token mints, amounts,
            references, and finality by hand. Different services then repeat
            that interpretation and can disagree about whether an invoice is
            actually paid.
          </p>
          <p>
            PayOps creates one inspectable payment truth. It records the exact
            invoice expectation, observes finalized Solana transfer facts,
            applies deterministic matching rules, and preserves the decision
            with replayable evidence before notifying downstream systems.
          </p>
          <aside>
            <Database size={24} weight="duotone" aria-hidden="true" />
            <span>
              <strong>The core promise</strong>
              The same canonical invoice and transfer produce the same result.
              Ambiguity is surfaced for review instead of guessed away.
            </span>
          </aside>
        </div>
      </section>
      <section className="docs-audience" aria-labelledby="docs-audience-title">
        <div className="docs-section-intro">
          <p className="docs-kicker">Target audience</p>
          <h2 id="docs-audience-title">Who PayOps is for</h2>
          <p>
            PayOps serves teams that accept Solana stablecoins and need the
            payment record to remain consistent across product, operations, and
            finance.
          </p>
        </div>
        <div className="docs-audience-grid">
          {audiences.map((audience) => (
            <article key={audience.title}>
              <span aria-hidden="true">{audience.icon}</span>
              <h3>{audience.title}</h3>
              <p>{audience.body}</p>
              <ul>
                {audience.outcomes.map((outcome) => (
                  <li key={outcome}>{outcome}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
      <section className="docs-truth-flow" aria-labelledby="docs-flow-title">
        <div className="docs-section-intro">
          <p className="docs-kicker">End-to-end model</p>
          <h2 id="docs-flow-title">How payment truth moves through PayOps</h2>
          <p>
            Four explicit boundaries turn a public chain transfer into a
            business event your systems can safely consume.
          </p>
        </div>
        <ol>
          {truthFlow.map((item) => (
            <li key={item.step}>
              <span>{item.step}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="docs-scope-note">
          <ShieldCheck size={24} weight="duotone" aria-hidden="true" />
          <p>
            <strong>Deliberately narrow:</strong> PayOps does not create
            wallets, custody funds, sign transactions, quote exchange rates, or
            replace your accounting system. It gives those systems a reliable
            reconciliation result and the evidence behind it.
          </p>
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
      <section
        className="docs-guide-overview"
        aria-labelledby="docs-guide-overview-title"
      >
        <div className="docs-guide-overview-intro">
          <p className="docs-kicker">Documentation path</p>
          <h2 id="docs-guide-overview-title">
            From first transfer to production operations.
          </h2>
          <p>
            Start with the working path, then go deeper into architecture,
            events, security, package boundaries, and the API surface as your
            integration grows.
          </p>
          <dl className="docs-guide-metrics">
            <div>
              <dt>Guides</dt>
              <dd>{docPages.length} guides</dd>
            </div>
            <div>
              <dt>Reading time</dt>
              <dd>{totalReadingMinutes} min total</dd>
            </div>
            <div>
              <dt>Contract</dt>
              <dd>v0.1 stable</dd>
            </div>
          </dl>
        </div>
        <div className="docs-guide-path">
          {docPages.map((page, index) => (
            <a
              className={
                index === 0
                  ? "docs-guide-card docs-guide-card-featured"
                  : "docs-guide-card"
              }
              href={`/docs/${page.slug}`}
              key={page.slug}
            >
              <div className="docs-guide-card-top">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <small>{index === 0 ? "Start here" : "Guide"}</small>
              </div>
              <h3>{page.label}</h3>
              <p>{page.summary}</p>
              <footer>
                <small>{page.readingTime} read</small>
                <span>
                  Open guide <ArrowRight size={17} aria-hidden="true" />
                </span>
              </footer>
            </a>
          ))}
        </div>
      </section>
    </DocsShell>
  );
}
