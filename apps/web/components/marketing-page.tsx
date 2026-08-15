import {
  ArrowRight,
  ArrowsClockwise,
  BracketsCurly,
  Check,
  CheckCircle,
  Code,
  Cube,
  FileText,
  GitBranch,
  LockKey,
  Package,
  Receipt,
  ShieldCheck,
  Storefront,
  Warning,
  WebhooksLogo,
} from "@phosphor-icons/react/ssr";
import { marketingDestinations } from "./marketing-destinations";
import { MarketingHeader } from "./marketing-header";
import { SdkCopy } from "./sdk-copy";

const checkoutUrl =
  "https://github.com/GautamBytes/solana-payment-ops/tree/main/apps/web";
const sdkUrl =
  "https://github.com/GautamBytes/solana-payment-ops/tree/main/packages/sdk";

export function MarketingPage() {
  return (
    <div className="marketing" id="top">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <MarketingHeader />

      <main id="main-content">
        <section
          className="hero marketing-section"
          aria-labelledby="hero-title"
        >
          <div className="hero-copy">
            <p className="eyebrow">Solana payment reconciliation</p>
            <h1 id="hero-title">Turn Solana payments into paid invoices.</h1>
            <p className="hero-summary">
              PayOps watches finalized USDC and USDT transfers, verifies every
              payment, matches it to the right invoice, and gives your team
              accounting-ready proof.
            </p>
            <div className="hero-actions">
              <a className="button" href="#how-it-works">
                See how it works <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a
                className="button button-secondary"
                href={marketingDestinations.pilotUrl}
              >
                Start a read-only pilot
              </a>
            </div>
            <p className="reassurance">
              <CheckCircle size={19} weight="fill" aria-hidden="true" />
              No custody. No private keys. Read-only by design.
            </p>
          </div>

          <article
            className="proof-panel"
            aria-label="Example reconciled invoice"
          >
            <header className="proof-panel-header">
              <div>
                <span>Invoice</span>
                <strong>INV-0421</strong>
              </div>
              <span className="proof-status">
                <CheckCircle size={17} weight="fill" aria-hidden="true" />
                Matched with proof
              </span>
            </header>
            <ol className="proof-steps">
              <ProofStep
                label="Customer sent 1,250 USDC"
                detail="1,250.00 USDC"
              />
              <ProofStep
                label="Payment finalized on Solana"
                detail="Finalized 09:38 UTC"
              />
              <ProofStep
                label="Exact amount and recipient verified"
                detail="USDC on Solana"
              />
              <ProofStep
                label="Invoice INV-0421 automatically marked paid"
                detail="Paid 09:41 UTC"
              />
            </ol>
            <footer className="proof-panel-footer">
              <div>
                <span>Transaction signature</span>
                <code>5zXk...yQ3e</code>
              </div>
              <a href={marketingDestinations.githubUrl}>
                View evidence <ArrowRight size={16} aria-hidden="true" />
              </a>
            </footer>
          </article>
        </section>

        <section className="trust-strip" aria-label="PayOps platform facts">
          <TrustItem
            icon={<Receipt />}
            title="USDC + USDT"
            detail="on Solana Mainnet"
          />
          <TrustItem
            icon={<ShieldCheck />}
            title="Finalized"
            detail="payments only"
          />
          <TrustItem
            icon={<BracketsCurly />}
            title="Apache-2.0"
            detail="open source"
          />
          <TrustItem icon={<Package />} title="7 npm" detail="packages" />
        </section>

        <section
          className="process marketing-section"
          id="how-it-works"
          aria-labelledby="process-title"
        >
          <div className="section-heading">
            <p className="eyebrow">From payment to proof</p>
            <h2 id="process-title">What happens after your customer pays?</h2>
          </div>
          <ol className="process-grid">
            <ProcessStep number="1" title="Detect">
              PayOps watches your settlement wallet.
            </ProcessStep>
            <ProcessStep number="2" title="Verify">
              It checks finality, token, recipient, amount, and invoice
              reference.
            </ProcessStep>
            <ProcessStep number="3" title="Match">
              The correct invoice is closed automatically.
            </ProcessStep>
            <ProcessStep number="4" title="Prove">
              Your team receives signed events and exportable evidence.
            </ProcessStep>
          </ol>
          <div className="exception-note">
            <Warning size={21} weight="fill" aria-hidden="true" />
            <p>
              If anything is unclear, it goes to review—never falsely marked
              paid.
            </p>
          </div>
        </section>

        <section
          className="paths marketing-section"
          aria-labelledby="paths-title"
        >
          <div className="section-heading">
            <p className="eyebrow">Choose your path</p>
            <h2 id="paths-title">One product. Two ways to use it.</h2>
          </div>
          <div className="path-grid">
            <article className="path" id="merchants">
              <Storefront size={40} aria-hidden="true" />
              <div>
                <p className="path-label">For merchants</p>
                <h3>
                  Accept stablecoin invoices and reconcile them automatically.
                </h3>
                <p>
                  See what happened, close the right invoice, and send clean
                  evidence to finance.
                </p>
                <div className="path-actions">
                  <a className="button" href={marketingDestinations.pilotUrl}>
                    Run a shadow audit
                  </a>
                  <a className="text-link" href={checkoutUrl}>
                    View checkout <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </div>
              </div>
            </article>
            <article className="path" id="developers">
              <Code size={42} aria-hidden="true" />
              <div>
                <p className="path-label">For developers</p>
                <h3>
                  Add deterministic Solana payment verification to your product.
                </h3>
                <p>
                  Build on typed contracts, signed lifecycle events, and a
                  replayable conformance corpus.
                </p>
                <div className="path-actions developer-actions">
                  <a className="button" href={sdkUrl}>
                    Explore the SDK
                  </a>
                  <SdkCopy />
                </div>
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
            <p className="eyebrow">Clear boundaries, reproducible results</p>
            <h2 id="trust-title">Why teams trust PayOps</h2>
          </div>
          <div className="trust-grid">
            <ProofPoint icon={<ArrowsClockwise />} title="Deterministic">
              Same transaction, same result.
            </ProofPoint>
            <ProofPoint icon={<LockKey />} title="Non-custodial">
              PayOps never signs or moves funds.
            </ProofPoint>
            <ProofPoint icon={<FileText />} title="Auditable">
              Every decision includes replayable evidence.
            </ProofPoint>
          </div>
          <div className="evidence-strip">
            <span>
              <CheckCircle size={20} weight="fill" aria-hidden="true" /> 25 / 25
              conformance
            </span>
            <span>
              <WebhooksLogo size={21} aria-hidden="true" /> Signed webhooks
              delivered
            </span>
            <span>
              <GitBranch size={21} aria-hidden="true" /> Open evidence contract
            </span>
          </div>
        </section>

        <section
          className="pilot marketing-section"
          id="pilot"
          aria-labelledby="pilot-title"
        >
          <div>
            <p className="eyebrow">Read-only merchant pilot</p>
            <h2 id="pilot-title">
              See what PayOps finds in your payment flow.
            </h2>
            <p>
              Run a shadow audit on historical Solana payments. No changes to
              your checkout or funds.
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
              Talk to us
            </a>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
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
      <span className="proof-check">
        <Check size={15} weight="bold" aria-hidden="true" />
      </span>
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
    </li>
  );
}

function TrustItem({
  icon,
  title,
  detail,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="trust-item">
      <span className="trust-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
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
      <span className="process-number">{number}</span>
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
      <span aria-hidden="true">{icon}</span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
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
        <strong>Developers</strong>
        <a href={sdkUrl}>SDK</a>
        <a href={marketingDestinations.docsUrl}>Docs</a>
        <a href={marketingDestinations.githubUrl}>GitHub</a>
      </div>
      <div>
        <strong>Trust</strong>
        <a href={marketingDestinations.githubUrl + "/blob/main/SECURITY.md"}>
          Security
        </a>
        <a href={marketingDestinations.githubUrl + "/blob/main/LICENSE"}>
          Apache-2.0
        </a>
        <a href={marketingDestinations.githubUrl + "/actions"}>Build status</a>
      </div>
      <p className="footer-note">
        © 2026 PayOps. Open infrastructure for verifiable Solana payments.
      </p>
    </footer>
  );
}
