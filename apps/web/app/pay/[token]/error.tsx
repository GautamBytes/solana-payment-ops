"use client";

export default function CheckoutError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <main className="checkout-shell">
      <section className="state-ticket" aria-labelledby="error-title">
        <p className="eyebrow">Connection interrupted</p>
        <h1 id="error-title">The invoice could not be loaded.</h1>
        <p>
          No payment request was changed. Check your connection and try again.
        </p>
        <button className="button button-primary" type="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
