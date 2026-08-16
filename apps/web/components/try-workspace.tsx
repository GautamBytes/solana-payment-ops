"use client";

import {
  CheckCircle,
  Flask,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { useState } from "react";

import type { TryPaymentDecision, TryWorkspace } from "../lib/try/types";
import { MarketingHeader } from "./marketing-header";
import { PublicWalletPanel } from "./try-public-wallet";

export function TryWorkspaceView({
  workspace,
  publicWalletEnabled,
  publicApiOrigin,
}: {
  readonly workspace: TryWorkspace;
  readonly publicWalletEnabled: boolean;
  readonly publicApiOrigin?: string;
}) {
  const [mode, setMode] = useState<"sample" | "wallet">("sample");
  const [selectedId, setSelectedId] = useState(workspace.decisions[0]!.id);
  const [guideVisible, setGuideVisible] = useState(true);
  const selected = workspace.decisions.find(({ id }) => id === selectedId)!;

  return (
    <div className="marketing try-experience" id="top">
      <a className="skip-link" href="#try-main">
        Skip to workspace
      </a>
      <MarketingHeader
        homeHref="/"
        sectionHrefPrefix="/"
        ctaHref="#workspace"
        ctaLabel="Open workspace"
      />
      <main className="try-shell" id="try-main">
        <section className="try-intro" aria-labelledby="try-title">
          <div>
            <p>Self-serve payment workspace</p>
            <h1 id="try-title">Try PayOps</h1>
          </div>
          <p>
            Inspect how finalized Solana payments become matched decisions,
            explicit exceptions, and replayable evidence.
          </p>
        </section>

        <div className="try-sample-disclosure" role="note">
          <Flask size={18} aria-hidden="true" />
          <strong>{mode === "sample" ? "Sample data" : "Public data"}</strong>
          <span>
            {mode === "sample"
              ? workspace.disclosure
              : "Read-only finalized activity from the public Solana blockchain."}
          </span>
        </div>

        <div className="try-workspace-frame" id="workspace">
          {publicWalletEnabled ? (
            <div
              className="try-modes"
              role="tablist"
              aria-label="PayOps data mode"
            >
              <button
                id="try-sample-tab"
                type="button"
                role="tab"
                aria-selected={mode === "sample"}
                aria-controls="try-sample-panel"
                onClick={() => setMode("sample")}
              >
                Explore sample workspace
              </button>
              <button
                id="try-wallet-tab"
                type="button"
                role="tab"
                aria-selected={mode === "wallet"}
                aria-controls="try-wallet-panel"
                onClick={() => setMode("wallet")}
              >
                Use a public wallet
              </button>
            </div>
          ) : null}

          <section
            id="try-sample-panel"
            role={publicWalletEnabled ? "tabpanel" : undefined}
            aria-labelledby={publicWalletEnabled ? "try-sample-tab" : undefined}
            hidden={publicWalletEnabled && mode !== "sample"}
          >
            {guideVisible ? (
              <aside className="try-guide" aria-label="Three things to explore">
                <strong>Three things to explore</strong>
                <ol>
                  <li>Open the matched invoice.</li>
                  <li>Review an exception.</li>
                  <li>Inspect Detect → Verify → Match → Prove.</li>
                </ol>
                <button type="button" onClick={() => setGuideVisible(false)}>
                  Dismiss guide
                </button>
              </aside>
            ) : null}
            <section
              className="try-summary"
              aria-label="Sample workspace summary"
            >
              <Summary
                label="Invoices"
                value={String(workspace.summary.invoices)}
              />
              <Summary
                label="Matched"
                value={String(workspace.summary.matchedPayments)}
              />
              <Summary
                label="Exceptions"
                value={String(workspace.summary.exceptions)}
              />
              <Summary
                label="Finalized volume"
                value={workspace.summary.finalizedVolume}
              />
            </section>
            <div className="try-grid">
              <section
                className="try-decisions"
                aria-labelledby="decisions-title"
              >
                <h2 id="decisions-title">Payment decisions</h2>
                <ul>
                  {workspace.decisions.map((decision) => (
                    <li key={decision.id}>
                      <button
                        type="button"
                        aria-pressed={decision.id === selected.id}
                        onClick={() => setSelectedId(decision.id)}
                      >
                        <DecisionLabel decision={decision} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <DecisionDetail decision={selected} />
            </div>
          </section>

          {publicWalletEnabled ? (
            <PublicWalletPanel
              hidden={mode !== "wallet"}
              {...(publicApiOrigin === undefined ? {} : { publicApiOrigin })}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Summary({
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

function DecisionLabel({
  decision,
}: {
  readonly decision: TryPaymentDecision;
}) {
  const matched = decision.state === "matched";
  return (
    <>
      <span className="try-decision-reference">
        {decision.invoiceReference}
      </span>
      <strong className="try-decision-amount">
        {decision.amountTokens} {decision.assetSymbol}
      </strong>
      <em
        className={`try-decision-badge ${matched ? "is-matched" : "is-exception"}`}
      >
        {matched ? (
          <CheckCircle aria-hidden="true" />
        ) : (
          <Warning aria-hidden="true" />
        )}
        {matched ? "Matched" : decision.exceptionLabel}
      </em>
    </>
  );
}

function DecisionDetail({
  decision,
}: {
  readonly decision: TryPaymentDecision;
}) {
  return (
    <section
      className="try-detail"
      aria-live="polite"
      aria-labelledby="decision-title"
    >
      <p className="try-decision-state">
        <span>
          {decision.state === "matched" ? "Payment matched" : "Needs review"}
        </span>
        {decision.exceptionLabel ? (
          <strong>{decision.exceptionLabel}</strong>
        ) : null}
      </p>
      <h2 id="decision-title">{decision.invoiceReference}</h2>
      <dl>
        <div>
          <dt>Signature</dt>
          <dd>{decision.signature}</dd>
        </div>
        <div>
          <dt>Recipient</dt>
          <dd>{decision.recipient}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd>{decision.reference}</dd>
        </div>
      </dl>
      <ol className="try-evidence">
        {decision.evidence.map((step) => (
          <li key={step.stage} data-outcome={step.outcome}>
            <div className="try-evidence-heading">
              <ShieldCheck aria-hidden="true" />
              <span>{step.stage}</span>
            </div>
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
