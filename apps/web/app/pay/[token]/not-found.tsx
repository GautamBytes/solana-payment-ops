export default function CheckoutNotFound() {
  return (
    <main className="checkout-shell">
      <section className="state-ticket" aria-labelledby="not-found-title">
        <p className="eyebrow">Link unavailable</p>
        <h1 id="not-found-title">This payment link cannot be used.</h1>
        <p>Ask the merchant for a current invoice payment link.</p>
      </section>
    </main>
  );
}
