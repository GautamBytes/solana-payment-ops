import type {
  FinalizedPaymentEvent,
  InvoiceRecord,
  ReconciliationDecision,
} from "../domain/types.js";
import { reconcileEvent } from "./reconcile-event.js";

export function reconcileBatch(
  events: readonly FinalizedPaymentEvent[],
  invoices: readonly InvoiceRecord[],
): readonly ReconciliationDecision[] {
  const currentInvoices = new Map(
    invoices.map((invoice) => [invoice.invoiceId, { ...invoice }]),
  );
  return [...events]
    .sort((left, right) => left.eventId.localeCompare(right.eventId))
    .map((event) => {
      const decision = reconcileEvent(event, [...currentInvoices.values()]);
      if (decision.kind === "allocation") {
        const invoice = currentInvoices.get(decision.invoiceId);
        if (invoice !== undefined) {
          currentInvoices.set(decision.invoiceId, {
            ...invoice,
            status: "matched",
          });
        }
      }
      return decision;
    });
}
