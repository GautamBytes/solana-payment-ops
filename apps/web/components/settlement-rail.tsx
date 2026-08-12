import type { PublicPaymentAttempt, PublicPaymentStatus } from "../lib/api";

const stations = [
  {
    key: "awaiting_payment",
    label: "Quote locked",
    note: "Exact request ready",
  },
  { key: "detected", label: "Transfer seen", note: "Found on Solana" },
  { key: "finalized", label: "Finality reached", note: "No longer reversible" },
  { key: "paid", label: "Invoice paid", note: "Merchant can settle" },
] as const;

export function SettlementRail({
  attempt,
}: {
  readonly attempt: PublicPaymentAttempt | null;
}) {
  const status = attempt?.status ?? "awaiting_payment";
  const completed = stationIndex(status);
  const exceptional =
    status === "exception" || status === "confirmation_revoked";
  return (
    <section className="settlement" aria-labelledby="settlement-title">
      <div className="section-heading">
        <p className="eyebrow">Live settlement</p>
        <h2 id="settlement-title">From request to receipt</h2>
      </div>
      <ol className="settlement-rail" data-exception={exceptional}>
        {stations.map((station, index) => (
          <li
            key={station.key}
            data-state={index <= completed ? "complete" : "pending"}
          >
            <span className="station-node" aria-hidden="true" />
            <span>
              <strong>{station.label}</strong>
              <small>
                {index === completed && attempt
                  ? statusCopy(status)
                  : station.note}
              </small>
            </span>
          </li>
        ))}
      </ol>
      {exceptional ? (
        <p className="rail-alert" role="status">
          {status === "confirmation_revoked"
            ? "The provisional transfer was reversed. Do not send again until the payment request is refreshed."
            : "This transfer needs merchant review and has not marked the invoice paid."}
        </p>
      ) : null}
    </section>
  );
}

export function stationIndex(status: PublicPaymentStatus): number {
  if (status === "paid") return 3;
  if (status === "finalized") return 2;
  if (status === "detected" || status === "confirmed") return 1;
  return 0;
}

function statusCopy(status: PublicPaymentStatus): string {
  switch (status) {
    case "confirmed":
      return "Seen by the network; still reversible";
    case "detected":
      return "Transfer found; waiting for confirmation";
    case "finalized":
      return "Final on Solana; allocating invoice";
    case "paid":
      return "Settlement complete";
    case "expired":
      return "Quote expired; create a new request";
    default:
      return "Exact request ready";
  }
}
