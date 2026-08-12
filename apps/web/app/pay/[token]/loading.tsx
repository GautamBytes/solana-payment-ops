export default function CheckoutLoading() {
  return (
    <main
      className="checkout-shell"
      aria-busy="true"
      aria-label="Loading secure invoice"
    >
      <section className="loading-ticket">
        <p className="eyebrow">Secure settlement</p>
        <h1>Loading invoice details…</h1>
        <p>The payment request will appear after its invoice is verified.</p>
      </section>
    </main>
  );
}
