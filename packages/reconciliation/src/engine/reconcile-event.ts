import type {
  ExceptionDecision,
  FinalizedPaymentEvent,
  InvoiceRecord,
  ReconciliationDecision,
} from "../domain/types.js";
import { RECONCILIATION_RULE_VERSION } from "../domain/types.js";

function exception(
  event: FinalizedPaymentEvent,
  code: ExceptionDecision["code"],
  invoiceId: string | null,
): ExceptionDecision {
  return {
    kind: "exception",
    code,
    ruleVersion: RECONCILIATION_RULE_VERSION,
    eventId: event.eventId,
    chainEventId: event.chainEventId,
    signature: event.signature,
    outerInstructionIndex: event.outerInstructionIndex,
    innerInstructionIndex: event.innerInstructionIndex,
    invoiceId,
    amountBaseUnits: event.amountBaseUnits,
  };
}

export function reconcileEvent(
  event: FinalizedPaymentEvent,
  invoices: readonly InvoiceRecord[],
): ReconciliationDecision {
  const candidates = invoices.filter((invoice) =>
    event.references.includes(invoice.referenceAddress),
  );
  if (candidates.length === 0) {
    return exception(
      event,
      event.references.length === 0 ? "missing_reference" : "unknown_reference",
      null,
    );
  }
  if (candidates.length > 1) {
    return exception(event, "ambiguous_reference", null);
  }
  const invoice = candidates[0];
  if (invoice === undefined) {
    return exception(event, "unknown_reference", null);
  }
  if (invoice.status === "matched") {
    return exception(event, "duplicate_payment", invoice.invoiceId);
  }
  if (event.mint !== invoice.expectedMint) {
    return exception(event, "wrong_asset", invoice.invoiceId);
  }
  if (event.destinationTokenAccount !== invoice.destinationTokenAccount) {
    return exception(event, "wrong_destination", invoice.invoiceId);
  }
  if (event.blockTime === null) {
    return exception(event, "missing_block_time", invoice.invoiceId);
  }
  if (event.blockTime.getTime() < invoice.issuedAt.getTime()) {
    return exception(event, "before_issue", invoice.invoiceId);
  }
  if (event.blockTime.getTime() > invoice.dueAt.getTime()) {
    return exception(event, "late_payment", invoice.invoiceId);
  }
  if (event.amountBaseUnits < invoice.amountBaseUnits) {
    return exception(event, "partial_payment", invoice.invoiceId);
  }
  if (event.amountBaseUnits > invoice.amountBaseUnits) {
    return exception(event, "excess_payment", invoice.invoiceId);
  }
  return {
    kind: "allocation",
    code: "exact_match",
    ruleVersion: RECONCILIATION_RULE_VERSION,
    eventId: event.eventId,
    chainEventId: event.chainEventId,
    signature: event.signature,
    outerInstructionIndex: event.outerInstructionIndex,
    innerInstructionIndex: event.innerInstructionIndex,
    invoiceId: invoice.invoiceId,
    amountBaseUnits: event.amountBaseUnits,
  };
}
