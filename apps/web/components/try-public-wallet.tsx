"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  analyzeWallet,
  isPublicAmount,
  isPublicSolanaAddress,
  PublicWalletClientError,
  type PublicAssetSymbol,
  type PublicWalletAnalysis,
  type PublicWalletAnalysisRequest,
} from "../lib/public-wallet-analysis";
import { WalletResults } from "./try-wallet-results";

type FieldName =
  "walletAddress" | "assetSymbol" | "amountTokens" | "recipient" | "reference";
type FieldErrors = Partial<Record<FieldName, string>>;

export function PublicWalletPanel({
  hidden,
  publicApiOrigin,
}: {
  readonly hidden: boolean;
  readonly publicApiOrigin?: string;
}) {
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
  const expectationsRef = useRef<HTMLDetailsElement>(null);
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
      if (firstError !== "walletAddress" && expectationsRef.current !== null) {
        expectationsRef.current.open = true;
      }
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
      const result = await analyzeWallet(input, publicApiOrigin);
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
          <strong>Public blockchain data only.</strong> Enter a public address,
          never a seed phrase or private key. PayOps does not connect to your
          wallet or request a signature.
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
        <details ref={expectationsRef} className="try-wallet-expectations">
          <summary>Compare against an expected payment</summary>
          <fieldset>
            <legend>Optional payment expectations</legend>
            <p>
              Add asset, amount, recipient, and reference to test an exact
              match. Leave this closed to inspect finalized transfers only.
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
        </details>
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
