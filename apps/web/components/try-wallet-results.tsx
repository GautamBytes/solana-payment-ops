import { CheckCircle, Warning } from "@phosphor-icons/react";
import type { RefObject } from "react";

import type {
  PublicExpectationStatus,
  PublicWalletAnalysis,
  PublicWalletTransfer,
} from "../lib/public-wallet-analysis";

export function WalletResults({
  analysis,
  resultRef,
}: {
  readonly analysis: PublicWalletAnalysis;
  readonly resultRef: RefObject<HTMLHeadingElement | null>;
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
          <Warning aria-hidden="true" /> Coverage is incomplete. Missing
          activity must not be treated as zero activity.
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
