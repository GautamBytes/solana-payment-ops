"use client";

import {
  CheckCircle,
  Flask,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  analyzeWallet,
  isPublicAmount,
  isPublicSolanaAddress,
  PublicWalletClientError,
  type PublicAssetSymbol,
  type PublicExpectationStatus,
  type PublicWalletAnalysis,
  type PublicWalletAnalysisRequest,
  type PublicWalletTransfer,
} from "../lib/public-wallet-analysis";
import type { TryPaymentDecision, TryWorkspace } from "../lib/try/types";

export function TryWorkspaceView({
  workspace,
  publicWalletEnabled,
}: {
  readonly workspace: TryWorkspace;
  readonly publicWalletEnabled: boolean;
}) {
  const [mode, setMode] = useState<"sample" | "wallet">("sample");
  const [selectedId, setSelectedId] = useState(workspace.decisions[0]!.id);
  const [guideVisible, setGuideVisible] = useState(true);
  const selected = workspace.decisions.find(({ id }) => id === selectedId)!;

  return (
    <main className="try-shell" id="try-main">
      <header className="try-header">
        <a className="try-brand" href="/">
          PayOps
        </a>
        <div className="try-sample-disclosure" role="note">
          <Flask size={18} aria-hidden="true" />
          <strong>{mode === "sample" ? "Sample data" : "Public data"}</strong>
          <span>
            {mode === "sample"
              ? workspace.disclosure
              : "Read-only finalized activity from the public Solana blockchain."}
          </span>
        </div>
      </header>
      <section className="try-intro" aria-labelledby="try-title">
        <p>Interactive product tour</p>
        <h1 id="try-title">Try PayOps</h1>
        <p>
          Inspect how finalized Solana payments become matched decisions,
          explicit exceptions, and replayable evidence.
        </p>
      </section>

      {publicWalletEnabled ? (
        <div className="try-modes" role="tablist" aria-label="PayOps data mode">
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
        <section className="try-summary" aria-label="Sample workspace summary">
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
          <section className="try-decisions" aria-labelledby="decisions-title">
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
        <PublicWalletPanel hidden={mode !== "wallet"} />
      ) : null}
    </main>
  );
}

type FieldName =
  "walletAddress" | "assetSymbol" | "amountTokens" | "recipient" | "reference";
type FieldErrors = Partial<Record<FieldName, string>>;

function PublicWalletPanel({ hidden }: { readonly hidden: boolean }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [rangeDays, setRangeDays] = useState<7 | 30>(7);
  const [assetSymbol, setAssetSymbol] = useState<"" | PublicAssetSymbol>("");
  const [amountTokens, setAmountTokens] = useState("");
  const [recipient, setRecipient] = useState("");
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [analysis, setAnalysis] = useState<PublicWalletAnalysis>();
  const [clientError, setClientError] = useState<PublicWalletClientError>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const walletRef = useRef<HTMLInputElement>(null);
  const assetRef = useRef<HTMLSelectElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const recipientRef = useRef<HTMLInputElement>(null);
  const referenceRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (analysis !== undefined) resultRef.current?.focus();
  }, [analysis]);
  useEffect(() => {
    if (clientError !== undefined) alertRef.current?.focus();
  }, [clientError]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    if (!isPublicSolanaAddress(walletAddress)) {
      nextErrors.walletAddress = "Enter a valid public Solana address.";
    }
    if (amountTokens !== "" && !isPublicAmount(amountTokens)) {
      nextErrors.amountTokens = "Use up to six decimal places.";
    }
    if (recipient !== "" && !isPublicSolanaAddress(recipient)) {
      nextErrors.recipient = "Enter a valid recipient wallet address.";
    } else if (recipient !== "" && assetSymbol === "") {
      nextErrors.assetSymbol = "Choose an asset for the recipient.";
    }
    if (reference !== "" && !isPublicSolanaAddress(reference)) {
      nextErrors.reference = "Enter a valid public reference address.";
    }
    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0] as FieldName | undefined;
    if (firstError !== undefined) {
      ({
        walletAddress: walletRef,
        assetSymbol: assetRef,
        amountTokens: amountRef,
        recipient: recipientRef,
        reference: referenceRef,
      })[firstError].current?.focus();
      setStatus("Check the highlighted field.");
      return;
    }

    const expectation = {
      ...(assetSymbol === "" ? {} : { assetSymbol }),
      ...(amountTokens === "" ? {} : { amountTokens }),
      ...(recipient === "" ? {} : { recipient }),
      ...(reference === "" ? {} : { reference }),
    };
    const input: PublicWalletAnalysisRequest = {
      walletAddress,
      rangeDays,
      ...(Object.keys(expectation).length === 0 ? {} : { expectation }),
    };
    setBusy(true);
    setClientError(undefined);
    setAnalysis(undefined);
    setStatus("Analyzing finalized public transfers…");
    try {
      const result = await analyzeWallet(input);
      setAnalysis(result);
      setStatus("Public wallet analysis complete.");
    } catch (error) {
      setClientError(
        error instanceof PublicWalletClientError
          ? error
          : new PublicWalletClientError("invalid_response"),
      );
      setStatus("Public wallet analysis could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="try-wallet-panel"
      role="tabpanel"
      aria-labelledby="try-wallet-tab"
      className="try-wallet-panel"
      aria-busy={busy}
      hidden={hidden}
    >
      <div className="try-wallet-heading">
        <div>
          <p>Read-only public-chain lookup</p>
          <h2>Inspect a public wallet</h2>
        </div>
        <p className="try-wallet-disclosure" role="note">
          <strong>Use public addresses only.</strong> Never enter a seed phrase
          or private key. PayOps never asks you to connect or sign. Results stay
          in this browser session and are not added to an account.
        </p>
      </div>
      <form className="try-wallet-form" noValidate onSubmit={submit}>
        <div className="try-wallet-field is-wide">
          <label htmlFor="try-wallet-address">Public wallet address</label>
          <input
            ref={walletRef}
            id="try-wallet-address"
            name="walletAddress"
            value={walletAddress}
            maxLength={44}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.walletAddress !== undefined}
            aria-describedby={
              errors.walletAddress === undefined
                ? "try-wallet-address-help"
                : "try-wallet-address-error"
            }
            onChange={(event) => setWalletAddress(event.target.value.trim())}
          />
          <span id="try-wallet-address-help">
            We derive canonical USDC and USDT token accounts from this address.
          </span>
          <FieldError
            id="try-wallet-address-error"
            message={errors.walletAddress}
          />
        </div>
        <div className="try-wallet-field">
          <label htmlFor="try-range-days">Date range</label>
          <select
            id="try-range-days"
            name="rangeDays"
            value={rangeDays}
            onChange={(event) =>
              setRangeDays(event.target.value === "30" ? 30 : 7)
            }
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
        <fieldset className="try-wallet-expectations">
          <legend>Optional payment expectations</legend>
          <p>
            Add all four fields to test a match. Leaving them blank still shows
            observed finalized transfers.
          </p>
          <div className="try-wallet-field">
            <label htmlFor="try-asset-symbol">Expected asset</label>
            <select
              ref={assetRef}
              id="try-asset-symbol"
              name="assetSymbol"
              value={assetSymbol}
              aria-invalid={errors.assetSymbol !== undefined}
              aria-describedby="try-asset-support try-asset-error"
              onChange={(event) =>
                setAssetSymbol(event.target.value as "" | PublicAssetSymbol)
              }
            >
              <option value="">Not provided</option>
              <option value="USDC">USDC</option>
              <option value="USDT">USDT</option>
            </select>
            <span id="try-asset-support">
              Currently supports canonical USDC and USDT transfers only.
            </span>
            <FieldError id="try-asset-error" message={errors.assetSymbol} />
          </div>
          <div className="try-wallet-field">
            <label htmlFor="try-amount-tokens">Expected amount</label>
            <input
              ref={amountRef}
              id="try-amount-tokens"
              name="amountTokens"
              inputMode="decimal"
              value={amountTokens}
              maxLength={25}
              placeholder="12.50"
              aria-invalid={errors.amountTokens !== undefined}
              aria-describedby="try-amount-error"
              onChange={(event) => setAmountTokens(event.target.value)}
            />
            <FieldError id="try-amount-error" message={errors.amountTokens} />
          </div>
          <div className="try-wallet-field">
            <label htmlFor="try-recipient">Expected recipient wallet</label>
            <input
              ref={recipientRef}
              id="try-recipient"
              name="recipient"
              value={recipient}
              maxLength={44}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.recipient !== undefined}
              aria-describedby="try-recipient-error"
              onChange={(event) => setRecipient(event.target.value.trim())}
            />
            <FieldError id="try-recipient-error" message={errors.recipient} />
          </div>
          <div className="try-wallet-field">
            <label htmlFor="try-reference">Expected reference</label>
            <input
              ref={referenceRef}
              id="try-reference"
              name="reference"
              value={reference}
              maxLength={44}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.reference !== undefined}
              aria-describedby="try-reference-error"
              onChange={(event) => setReference(event.target.value.trim())}
            />
            <FieldError id="try-reference-error" message={errors.reference} />
          </div>
        </fieldset>
        <button className="try-wallet-submit" type="submit" disabled={busy}>
          {busy ? "Analyzing…" : "Analyze wallet"}
        </button>
        <p className="try-wallet-status" role="status" aria-live="polite">
          {status}
        </p>
      </form>

      {clientError !== undefined ? (
        <div ref={alertRef} className="try-error" role="alert" tabIndex={-1}>
          {clientErrorMessage(clientError)}
        </div>
      ) : null}
      {analysis !== undefined ? (
        <WalletResults analysis={analysis} resultRef={resultRef} />
      ) : null}
    </section>
  );
}

function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  return message === undefined ? null : (
    <strong className="try-field-error" id={id}>
      {message}
    </strong>
  );
}

function clientErrorMessage(error: PublicWalletClientError): string {
  switch (error.code) {
    case "invalid_request":
      return "Check the public address and payment expectations.";
    case "rate_limited":
      return `Too many analyses. Try again in ${error.retryAfterSeconds ?? 60} seconds.`;
    case "unavailable":
      return "Live analysis is temporarily unavailable. The sample workspace still works.";
    case "invalid_response":
      return `Live analysis returned an unreadable response. Try again later.${error.requestId === undefined ? "" : ` Reference: ${error.requestId}.`}`;
  }
}

function WalletResults({
  analysis,
  resultRef,
}: {
  readonly analysis: PublicWalletAnalysis;
  readonly resultRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section
      className="try-wallet-results"
      aria-labelledby="wallet-results-title"
    >
      <div className="try-wallet-results-heading">
        <div>
          <p>
            {analysis.coverage === "complete"
              ? "Complete range"
              : "Partial range"}
          </p>
          <h2 ref={resultRef} id="wallet-results-title" tabIndex={-1}>
            Finalized transfer evidence
          </h2>
        </div>
        <p>Currently supports canonical USDC and USDT transfers only.</p>
      </div>
      {analysis.coverage === "partial" ? (
        <p className="try-coverage-warning" role="note">
          <Warning aria-hidden="true" /> Coverage is incomplete. Do not treat
          missing activity as zero activity.
        </p>
      ) : null}
      {analysis.transfers.length === 0 ? (
        <p className="try-wallet-empty">
          No finalized canonical USDC or USDT transfers were found in this
          range.
        </p>
      ) : (
        <div className="try-wallet-cards">
          {analysis.transfers.map((transfer) => (
            <WalletTransferCard
              key={`${transfer.signature}:${transfer.destinationTokenAccount}`}
              transfer={transfer}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WalletTransferCard({
  transfer,
}: {
  readonly transfer: PublicWalletTransfer;
}) {
  return (
    <article
      className="try-wallet-card"
      data-status={transfer.expectationStatus}
    >
      <header>
        <div>
          <span>{new Date(transfer.blockTime).toLocaleString()}</span>
          <strong>
            {transfer.amountTokens} {transfer.assetSymbol}
          </strong>
        </div>
        <em>{expectationLabel(transfer.expectationStatus)}</em>
      </header>
      <p>{expectationMessage(transfer.expectationStatus)}</p>
      <dl>
        <div>
          <dt>Signature</dt>
          <dd>{transfer.signature}</dd>
        </div>
        <div>
          <dt>Destination token account</dt>
          <dd>{transfer.destinationTokenAccount}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd>{transfer.references[0] ?? "None observed"}</dd>
        </div>
      </dl>
      {transfer.expectationChecks.length > 0 ? (
        <ul className="try-wallet-checks" aria-label="Expectation checks">
          {transfer.expectationChecks.map((check) => (
            <li key={check.field} data-passed={check.passed}>
              {check.passed ? (
                <CheckCircle aria-hidden="true" />
              ) : (
                <Warning aria-hidden="true" />
              )}
              <span>{check.field}</span>
              <strong>{check.passed ? "Matches" : "Does not match"}</strong>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function expectationLabel(status: PublicExpectationStatus): string {
  return {
    not_provided: "Observed",
    partial: "Expectations incomplete",
    matched: "Matched",
    not_matched: "Not matched",
  }[status];
}

function expectationMessage(status: PublicExpectationStatus): string {
  return {
    not_provided: "Public transfer verified; no invoice expectations supplied.",
    partial:
      "Public transfer verified; add all four expectations to test a match.",
    matched: "All supplied payment expectations match this finalized transfer.",
    not_matched:
      "The finalized transfer does not match every supplied expectation.",
  }[status];
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
