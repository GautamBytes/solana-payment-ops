import {
  ArrowRight,
  ArrowsClockwise,
  Check,
  CheckCircle,
  Code,
  FileText,
  GithubLogo,
  LockKey,
  ShieldCheck,
  Storefront,
  Warning,
  WebhooksLogo,
} from "@phosphor-icons/react/ssr";
import { marketingDestinations } from "./marketing-destinations";
import { MarketingHeader } from "./marketing-header";
import { SdkCopy } from "./sdk-copy";

const guideCards = [
  {
    href: "/docs/quickstart",
    index: "01",
    title: "Quickstart",
    detail: "Reconcile your first finalized transfer in five minutes.",
  },
  {
    href: "/docs/architecture",
    index: "02",
    title: "Architecture",
    detail: "See how payment facts become replayable evidence.",
  },
  {
    href: "/docs/lifecycle",
    index: "03",
    title: "Lifecycle events",
    detail: "Consume signed, versioned invoice and exception events.",
  },
  {
    href: "/docs/api",
    index: "04",
    title: "API reference",
    detail: "Build merchant workflows against typed HTTP endpoints.",
  },
] as const;

export function MarketingPage() {
  return (
    <div className="marketing" id="top">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <MarketingHeader />
      <main id="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-visual" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-copy">
              <p className="signal-pill">
                <span>Solana payment integrity</span>
                <strong>USDC + USDT</strong>
              </p>
              <h1 id="hero-title">
                Know exactly which Solana payments got you paid.
              </h1>
              <p className="hero-summary">
                PayOps watches finalized USDC and USDT transfers, matches each
                one to the right invoice, and preserves proof your product and
                finance team can trust.
              </p>
              <div className="hero-actions">
                <a className="button" href="#how-it-works">
                  See how it works <ArrowRight size={18} aria-hidden="true" />
                </a>
                <a className="button button-secondary" href="/docs">
                  Open the docs
                </a>
              </div>
              <p className="reassurance">
                <CheckCircle size={19} weight="fill" aria-hidden="true" />
                No custody. No private keys. Read-only by design.
              </p>
            </div>
            <PaymentProof />
          </div>
        </section>

        <section
          className="marketing-proof-rail"
          aria-label="PayOps platform facts"
        >
          <Metric label="Tokens" value="USDC + USDT" />
          <Metric label="Chain state" value="Finalized only" />
          <Metric label="Conformance" value="25 / 25" />
          <Metric label="Distribution" value="7 npm packages" />
        </section>

        <section className="plain-language marketing-section">
          <p className="eyebrow">The job PayOps does</p>
          <p>
            Your customer sends stablecoins. PayOps proves what arrived,
            identifies the invoice it belongs to, and gives every downstream
            system the same answer.
          </p>
        </section>

        <section
          className="process marketing-section"
          id="how-it-works"
          aria-labelledby="process-title"
        >
          <div className="section-heading">
            <p className="eyebrow">From transfer to trusted record</p>
            <h2 id="process-title">What happens after your customer pays?</h2>
            <p>
              Four explicit stages turn a Solana transfer into an accounting
              decision without hiding uncertainty.
            </p>
          </div>
          <ol className="process-grid">
            <ProcessStep number="01" title="Detect">
              Watch the settlement wallet for finalized USDC and USDT.
            </ProcessStep>
            <ProcessStep number="02" title="Verify">
              Check token, recipient, amount, reference, and finality.
            </ProcessStep>
            <ProcessStep number="03" title="Match">
              Close only the invoice that exactly matches those facts.
            </ProcessStep>
            <ProcessStep number="04" title="Prove">
              Store replayable evidence and deliver a signed lifecycle event.
            </ProcessStep>
          </ol>
          <div className="exception-note">
            <Warning size={22} weight="fill" aria-hidden="true" />
            <p>
              If anything is unclear, it goes to review—never falsely marked
              paid.
            </p>
          </div>
        </section>

        <section className="docs-showcase marketing-section" id="developers">
          <div className="docs-showcase-copy">
            <p className="eyebrow">Documentation built into the product site</p>
            <h2>Understand the system before you integrate it.</h2>
            <p>
              Learn the data flow, event contract, security boundaries,
              packages, and API without jumping between repository files.
            </p>
            <a className="button" href="/docs">
              Open the docs <ArrowRight size={18} aria-hidden="true" />
            </a>
          </div>
          <div
            className="docs-window"
            aria-label="PayOps documentation preview"
          >
            <aside>
              <div className="mini-brand">
                <img src="/icon.svg" width="26" height="26" alt="" />
                <strong>PayOps</strong>
                <span>Docs</span>
              </div>
              <p>Get started</p>
              {guideCards.map((guide, index) => (
                <a
                  className={index === 0 ? "active" : undefined}
                  href={guide.href}
                  key={guide.href}
                >
                  {guide.title}
                </a>
              ))}
              <a href="/docs/security">Security</a>
              <a href="/docs/packages">Packages</a>
            </aside>
            <div className="docs-window-main">
              <p className="window-tabs">
                <span>Guide</span>
                <span>API</span>
                <span>Packages</span>
              </p>
              <small>Getting started</small>
              <h3>Start reconciling Solana payments</h3>
              <p>
                Install the SDK, define an invoice, and turn a finalized
                transfer into a deterministic decision.
              </p>
              <code>npm install @payops/sdk</code>
              <div className="window-checks">
                <span>
                  <Check size={15} /> Verify finality
                </span>
                <span>
                  <Check size={15} /> Match exact amount
                </span>
                <span>
                  <Check size={15} /> Save evidence
                </span>
              </div>
            </div>
          </div>
          <div className="guide-grid">
            {guideCards.map((guide) => (
              <a href={guide.href} key={guide.href}>
                <span>{guide.index}</span>
                <h3>{guide.title}</h3>
                <p>{guide.detail}</p>
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>

        <section
          className="paths marketing-section"
          aria-labelledby="paths-title"
        >
          <div className="section-heading">
            <p className="eyebrow">Use PayOps at your boundary</p>
            <h2 id="paths-title">One payment truth. Two teams unblocked.</h2>
          </div>
          <div className="path-grid">
            <article className="path" id="merchants">
              <Storefront size={34} aria-hidden="true" />
              <p className="path-label">For merchants</p>
              <h3>Stop reconciling stablecoin invoices by hand.</h3>
              <p>
                Know which invoices are paid, which transfers need review, and
                what evidence belongs in finance.
              </p>
              <a href={marketingDestinations.pilotUrl}>
                Start a read-only pilot{" "}
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </article>
            <article className="path">
              <Code size={36} aria-hidden="true" />
              <p className="path-label">For developers</p>
              <h3>Add deterministic payment state to your product.</h3>
              <p>
                Build on typed contracts, signed events, replayable fixtures,
                and explicit exceptions.
              </p>
              <div className="developer-actions">
                <a href={marketingDestinations.integrationUrl}>
                  Integration guide <ArrowRight size={17} aria-hidden="true" />
                </a>
                <SdkCopy />
              </div>
            </article>
          </div>
        </section>

        <section
          className="trust marketing-section"
          id="trust"
          aria-labelledby="trust-title"
        >
          <div className="section-heading">
            <p className="eyebrow">Inspect the boundaries</p>
            <h2 id="trust-title">Why teams trust PayOps</h2>
          </div>
          <div className="trust-grid">
            <ProofPoint icon={<ArrowsClockwise />} title="Deterministic">
              Same canonical transfer and invoice, same result.
            </ProofPoint>
            <ProofPoint icon={<LockKey />} title="Non-custodial">
              PayOps never signs transactions or moves funds.
            </ProofPoint>
            <ProofPoint icon={<FileText />} title="Auditable">
              Every payment decision preserves replayable evidence.
            </ProofPoint>
          </div>
          <div className="evidence-strip">
            <span>
              <CheckCircle size={20} weight="fill" /> 25 / 25 conformance
            </span>
            <span>
              <WebhooksLogo size={21} /> Exact-byte signed webhooks
            </span>
            <span>
              <ShieldCheck size={21} /> Fail-closed exceptions
            </span>
          </div>
          <a className="trust-link" href={marketingDestinations.securityUrl}>
            Read the security model <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>

        <section
          className="pilot marketing-section"
          id="pilot"
          aria-labelledby="pilot-title"
        >
          <div>
            <p className="eyebrow">Start with evidence, not a migration</p>
            <h2 id="pilot-title">
              See what PayOps finds in your payment flow.
            </h2>
            <p>
              Run a read-only shadow audit on historical Solana payments. No
              checkout changes. No signing authority. No funds moved.
            </p>
          </div>
          <div className="pilot-actions">
            <a className="button" href={marketingDestinations.pilotUrl}>
              Start a pilot <ArrowRight size={18} aria-hidden="true" />
            </a>
            <a
              className="button button-secondary"
              href={marketingDestinations.talkUrl}
            >
              Ask a question
            </a>
          </div>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}

function PaymentProof() {
  return (
    <article className="proof-panel" aria-label="Example reconciled invoice">
      <header>
        <span>Payment decision</span>
        <strong>
          <CheckCircle size={17} weight="fill" /> Matched
        </strong>
      </header>
      <div className="proof-invoice">
        <p>Invoice</p>
        <h2>INV-0421</h2>
        <span>1,250.00 USDC</span>
      </div>
      <ol>
        <ProofStep label="Transfer finalized" detail="09:38:12 UTC" />
        <ProofStep label="Mint and recipient verified" detail="USDC · Solana" />
        <ProofStep label="Exact amount matched" detail="1,250.00" />
        <ProofStep label="Evidence persisted" detail="evt_8b31…e2" />
      </ol>
      <footer>
        <span>Signed lifecycle event ready</span>
        <a href="/docs/lifecycle">
          Inspect event <ArrowRight size={15} />
        </a>
      </footer>
    </article>
  );
}

function ProofStep({
  label,
  detail,
}: {
  readonly label: string;
  readonly detail: string;
}) {
  return (
    <li>
      <span>
        <Check size={14} weight="bold" aria-hidden="true" />
      </span>
      <strong>{label}</strong>
      <small>{detail}</small>
    </li>
  );
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProcessStep({
  number,
  title,
  children,
}: {
  readonly number: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <li>
      <span>{number}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

function ProofPoint({
  icon,
  title,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <article className="proof-point">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <div className="footer-brand">
        <img src="/icon.svg" width="32" height="32" alt="" />
        <strong>PayOps</strong>
        <p>Payment integrity for Solana commerce.</p>
      </div>
      <div>
        <strong>Product</strong>
        <a href="#how-it-works">How it works</a>
        <a href="#merchants">For merchants</a>
        <a href="#developers">For developers</a>
      </div>
      <div>
        <strong>Documentation</strong>
        <a href="/docs/quickstart">Quickstart</a>
        <a href="/docs/integration">Integration</a>
        <a href="/docs/api">API reference</a>
        <a href="/docs/packages">Packages</a>
      </div>
      <div>
        <strong>Trust</strong>
        <a href="/docs/security">Security</a>
        <a href="/docs/architecture">Architecture</a>
        <a href={marketingDestinations.githubUrl}>
          <GithubLogo size={16} /> GitHub
        </a>
      </div>
      <p className="footer-note">
        © 2026 PayOps. Open infrastructure for verifiable Solana payments.
      </p>
    </footer>
  );
}
