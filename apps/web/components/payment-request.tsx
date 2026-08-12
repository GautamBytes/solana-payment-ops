"use client";

import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";
import type { PublicPaymentAttempt } from "../lib/api";
import { ExpiryClock } from "./expiry-clock";

export function PaymentRequest({
  attempt,
  now,
  onRefresh,
}: {
  readonly attempt: PublicPaymentAttempt;
  readonly now: number;
  readonly onRefresh: () => void;
}) {
  const [notice, setNotice] = useState("");
  const expired = now >= new Date(attempt.quoteExpiresAt).getTime();
  const payable = attempt.status === "awaiting_payment" && !expired;
  const refreshable =
    attempt.status === "expired" ||
    (attempt.status === "awaiting_payment" && expired);
  const modules = useMemo(
    () => qrModules(attempt.paymentUrl),
    [attempt.paymentUrl],
  );
  const recipient =
    attempt.paymentUrl.slice("solana:".length).split("?")[0] ?? "";

  async function copy(value: string, confirmation: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(confirmation);
    } catch {
      setNotice("Copy failed. Select and copy the value from request details.");
    }
  }

  return (
    <section className="payment-request" aria-labelledby="request-title">
      <div className="request-heading">
        <div>
          <p className="eyebrow">Exact payment request</p>
          <h2 id="request-title">
            {attempt.amountTokens} <span>{attempt.assetSymbol}</span>
          </h2>
        </div>
        <ExpiryClock expiresAt={attempt.quoteExpiresAt} now={now} />
      </div>
      {payable ? (
        <div className="request-body">
          <figure
            className="qr-frame"
            aria-label={`QR code for a Solana Pay request of ${attempt.amountTokens} ${attempt.assetSymbol}`}
          >
            <QrGraphic modules={modules} />
            <figcaption>Scan with a Solana Pay wallet</figcaption>
          </figure>
          <div className="request-actions">
            <a
              className="button button-primary"
              href={attempt.paymentUrl}
              rel="noreferrer"
            >
              Open in wallet
            </a>
            <button
              className="button button-secondary"
              type="button"
              onClick={() =>
                void copy(attempt.paymentUrl, "Payment link copied")
              }
            >
              Copy payment link
            </button>
            <p className="copy-notice" aria-live="polite">
              {notice}
            </p>
          </div>
        </div>
      ) : (
        <div className="request-actions">
          {refreshable ? (
            <button
              type="button"
              className="button button-primary"
              onClick={onRefresh}
            >
              Get a new quote
            </button>
          ) : (
            <p role="status">Payment submission is closed for this request.</p>
          )}
        </div>
      )}
      {payable ? (
        <details className="request-details">
          <summary>Verified request details</summary>
          <dl>
            <div>
              <dt>Asset</dt>
              <dd>{attempt.assetSymbol}</dd>
            </div>
            <div>
              <dt>Mint</dt>
              <dd>
                <code>{attempt.mint}</code>
              </dd>
            </div>
            <div>
              <dt>Recipient</dt>
              <dd>
                <code>{recipient}</code>
              </dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd>
                <code>{attempt.reference}</code>
              </dd>
            </div>
            <div>
              <dt>Base units</dt>
              <dd>
                <code>{attempt.amountBaseUnits}</code>
              </dd>
            </div>
          </dl>
          <button
            className="text-button"
            type="button"
            onClick={() => void copy(recipient, "Address copied")}
          >
            Copy recipient address
          </button>
        </details>
      ) : null}
    </section>
  );
}

function QrGraphic({
  modules,
}: {
  readonly modules: readonly (readonly boolean[])[];
}) {
  const size = modules.length;
  return (
    <svg
      viewBox={`0 0 ${size + 8} ${size + 8}`}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <rect width={size + 8} height={size + 8} fill="#fff" />
      {modules.flatMap((row, y) =>
        row.map((filled, x) =>
          filled ? (
            <rect
              key={`${x}-${y}`}
              x={x + 4}
              y={y + 4}
              width="1"
              height="1"
              fill="#14213d"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

function qrModules(value: string): readonly (readonly boolean[])[] {
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();
  return Array.from({ length: qr.getModuleCount() }, (_, row) =>
    Array.from({ length: qr.getModuleCount() }, (_, column) =>
      qr.isDark(row, column),
    ),
  );
}
