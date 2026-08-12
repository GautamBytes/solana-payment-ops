"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetChoice } from "../../../components/asset-choice";
import { PaymentRequest } from "../../../components/payment-request";
import { SettlementRail } from "../../../components/settlement-rail";
import {
  checkoutTokenFromPath,
  createPaymentAttempt,
  fetchPaymentStatus,
  formatMinorUnits,
  type AssetSymbol,
  type PublicCheckout,
  type PublicPaymentAttempt,
} from "../../../lib/api";
import { nextStatusPollDelay, statusAnnouncement } from "../../../lib/polling";

export function CheckoutClient({
  initialCheckout,
}: {
  readonly initialCheckout: PublicCheckout;
}) {
  const [selected, setSelected] = useState<AssetSymbol | null>(null);
  const [attempt, setAttempt] = useState<PublicPaymentAttempt | null>(
    initialCheckout.currentAttempt,
  );
  const [invoiceStatus, setInvoiceStatus] = useState(
    initialCheckout.invoice.status,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const etag = useRef<string | null>(null);
  const pendingQuote = useRef<{
    readonly assetSymbol: AssetSymbol;
    readonly key: string;
  } | null>(null);
  const lastAttemptStatus = useRef(attempt?.status);
  const token = useMemo(
    () =>
      typeof window === "undefined"
        ? ""
        : checkoutTokenFromPath(window.location.pathname),
    [],
  );

  const createQuote = useCallback(
    async (requested?: AssetSymbol) => {
      const assetSymbol = requested ?? selected;
      if (assetSymbol === null || token === "") return;
      setBusy(true);
      setMessage("");
      try {
        if (pendingQuote.current?.assetSymbol !== assetSymbol) {
          pendingQuote.current = {
            assetSymbol,
            key: globalThis.crypto.randomUUID(),
          };
        }
        const created = await createPaymentAttempt(
          token,
          assetSymbol,
          pendingQuote.current.key,
        );
        pendingQuote.current = null;
        setAttempt(created);
        setMessage(`Exact ${assetSymbol} request created.`);
      } catch (error) {
        setMessage(
          error instanceof Error && error.message === "attempt_active"
            ? "A current payment request already exists. Its status will refresh here."
            : "A safe quote is not available right now. No payment request was changed.",
        );
      } finally {
        setBusy(false);
      }
    },
    [selected, token],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (
      token === "" ||
      attempt === null ||
      ["paid", "exception"].includes(attempt.status)
    )
      return;
    let stopped = false;
    let timeout = 0;
    let consecutiveFailures = 0;
    const startedAt = Date.now();
    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        timeout = window.setTimeout(() => void poll(), 15_000);
        return;
      }
      try {
        const result = await fetchPaymentStatus(token, etag.current);
        etag.current = result.etag;
        if (result.status !== null) {
          setInvoiceStatus(result.status.invoiceStatus);
          const next = result.status.currentAttempt;
          if (next !== null && next.status !== lastAttemptStatus.current) {
            setMessage(statusAnnouncement(next.status));
          }
          lastAttemptStatus.current = next?.status;
          setAttempt(next);
        }
        consecutiveFailures = 0;
        setMessage((current) =>
          current.startsWith("Status update delayed") ? "" : current,
        );
      } catch {
        consecutiveFailures += 1;
        const delay = nextStatusPollDelay({
          elapsedMs: Date.now() - startedAt,
          consecutiveFailures,
          random: Math.random(),
        });
        setMessage(
          `Status update delayed. Retrying in ${Math.ceil(delay / 1_000)} seconds.`,
        );
        timeout = window.setTimeout(() => void poll(), delay);
        return;
      }
      const delay = nextStatusPollDelay({
        elapsedMs: Date.now() - startedAt,
        consecutiveFailures,
        random: Math.random(),
      });
      timeout = window.setTimeout(() => void poll(), delay);
    };
    const visible = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timeout);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", visible);
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [attempt?.publicAttemptId, attempt?.status, token]);

  const due = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(initialCheckout.invoice.dueAt));
  return (
    <main className="checkout-shell">
      <header className="brand-bar">
        <span className="brand-mark" aria-hidden="true">
          P
        </span>
        <span>PayOps secure checkout</span>
        <span className="network-mark">SOLANA · MAINNET</span>
      </header>
      <article className="settlement-ticket">
        <section className="invoice-panel" aria-labelledby="invoice-title">
          <div className="merchant-lockup">
            <p className="eyebrow">Invoice from</p>
            <h1 id="invoice-title">{initialCheckout.merchant.displayName}</h1>
          </div>
          <div className="invoice-total">
            <span>Amount due</span>
            <strong>
              {formatMinorUnits(
                initialCheckout.invoice.currency,
                initialCheckout.invoice.totalMinorUnits,
              )}
            </strong>
          </div>
          <dl className="invoice-meta">
            <div>
              <dt>Invoice</dt>
              <dd>{initialCheckout.invoice.publicReference}</dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>{due} UTC</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className="status-chip" data-status={invoiceStatus}>
                  {invoiceStatus}
                </span>
              </dd>
            </div>
          </dl>
          <p className="invoice-note">
            Pay the exact stablecoin request. PayOps watches Solana and marks
            this invoice paid only after finality.
          </p>
        </section>
        <section className="action-panel" aria-label="Payment request">
          {attempt === null ? (
            <>
              <div className="section-heading">
                <p className="eyebrow">Select settlement asset</p>
                <h2>Create an exact request</h2>
                <p>One quote. One reference. No wallet connection to PayOps.</p>
              </div>
              <AssetChoice
                assets={initialCheckout.acceptedAssets}
                selected={selected}
                disabled={busy}
                onSelect={setSelected}
              />
              <button
                className="button button-primary quote-button"
                type="button"
                disabled={selected === null || busy}
                onClick={() => void createQuote()}
              >
                {busy
                  ? "Checking safe rate…"
                  : selected === null
                    ? "Choose USDC or USDT"
                    : `Lock ${selected} quote`}
              </button>
            </>
          ) : (
            <PaymentRequest
              attempt={attempt}
              now={now}
              onRefresh={() => void createQuote(attempt.assetSymbol)}
            />
          )}
          <p className="live-message" aria-live="polite">
            {message}
          </p>
          <footer className="safety-note">
            <span aria-hidden="true">✓</span>
            <p>
              <strong>No wallet connection required.</strong> PayOps never asks
              for your seed phrase or private key.
            </p>
          </footer>
        </section>
        <div className="rail-panel">
          <SettlementRail attempt={attempt} />
        </div>
      </article>
      <p className="page-foot">
        Settlement status is verified from finalized Solana transfer evidence.
      </p>
    </main>
  );
}
