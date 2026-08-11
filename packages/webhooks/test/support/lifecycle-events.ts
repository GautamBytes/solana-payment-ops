import type { LifecycleEvent } from "../../src/index.js";

export const TEST_SIGNATURE =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
export const TEST_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TEST_ADDRESS = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";

export const lifecycleInputs = [
  lifecycle("invoice.issued", "invoice", "invoice-001", "issued", {
    invoiceId: "invoice-001",
    customerId: "customer-001",
    publicReference: "INV-2026-001",
    currency: "USD",
    totalMinorUnits: "1250",
    dueAt: "2026-08-20T00:00:00.000Z",
    issuedAt: "2026-08-11T00:00:00.000Z",
    acceptedAssetSymbols: ["USDC", "USDT"],
  }),
  lifecycle("invoice.cancelled", "invoice", "invoice-001", "cancelled", {
    invoiceId: "invoice-001",
    publicReference: "INV-2026-001",
    previousState: "issued",
    reasonCode: "customer_request",
    actorKind: "member",
    cancelledAt: "2026-08-11T12:00:00.000Z",
  }),
  paymentObserved("payment.detected", "detected"),
  paymentObserved("payment.confirmed", "confirmed"),
  paymentObserved("payment.finalized", "finalized"),
  lifecycle(
    "payment.confirmation_revoked",
    "payment",
    "attempt-001",
    "reverted",
    {
      paymentAttemptId: "attempt-001",
      invoiceId: "invoice-001",
      eventId: "chain-event-001",
      signature: TEST_SIGNATURE,
      previousState: "confirmed",
      currentState: "reverted",
      code: "finality_content_conflict",
    },
  ),
  lifecycle(
    "payment.exception_created",
    "payment_exception",
    "exception-001",
    "open",
    {
      exceptionId: "exception-001",
      invoiceId: "invoice-001",
      eventId: "chain-event-001",
      signature: TEST_SIGNATURE,
      outerInstructionIndex: 0,
      innerInstructionIndex: null,
      amountBaseUnits: "12500000",
      code: "wrong_asset",
      ruleVersion: "0.1",
      reviewState: "open",
    },
  ),
  lifecycle("invoice.partial", "invoice", "invoice-001", "partial", {
    invoiceId: "invoice-001",
    customerId: "customer-001",
    eventId: "chain-event-001",
    allocatedBaseUnits: "5000000",
    outstandingBaseUnits: "7500000",
    mint: TEST_MINT,
    ruleVersion: "0.1",
  }),
  lifecycle("invoice.paid", "invoice", "invoice-001", "paid", {
    invoiceId: "invoice-001",
    customerId: "customer-001",
    eventId: "chain-event-001",
    signature: TEST_SIGNATURE,
    outerInstructionIndex: 0,
    innerInstructionIndex: null,
    mint: TEST_MINT,
    amountBaseUnits: "12500000",
    ruleCode: "exact_match",
    ruleVersion: "0.1",
  }),
  lifecycle("invoice.overpaid", "invoice", "invoice-001", "overpaid", {
    invoiceId: "invoice-001",
    customerId: "customer-001",
    eventId: "chain-event-001",
    allocatedBaseUnits: "12500000",
    outstandingBaseUnits: "0",
    excessBaseUnits: "1000000",
    mint: TEST_MINT,
    ruleVersion: "0.1",
  }),
  lifecycle("refund.prepared", "refund", "refund-001", "prepared", {
    refundId: "refund-001",
    invoiceId: "invoice-001",
    allocationId: "allocation-001",
    mint: TEST_MINT,
    amountBaseUnits: "1000000",
    returnOwner: TEST_ADDRESS,
    approvalState: "approved",
  }),
  lifecycle("refund.finalized", "refund", "refund-001", "finalized", {
    refundId: "refund-001",
    invoiceId: "invoice-001",
    signature: TEST_SIGNATURE,
    eventId: "chain-event-refund-001",
    mint: TEST_MINT,
    amountBaseUnits: "1000000",
  }),
  lifecycle("evidence.ready", "evidence_pack", "evidence-001", "ready", {
    evidencePackId: "evidence-001",
    invoiceId: "invoice-001",
    manifestDigest: "a".repeat(64),
    signingKeyId: "signing-key-001",
    resourceId: "resource-001",
  }),
] as const satisfies readonly LifecycleEvent[];

function paymentObserved(
  type: "payment.detected" | "payment.confirmed" | "payment.finalized",
  commitment: "detected" | "confirmed" | "finalized",
) {
  return lifecycle(type, "payment", "attempt-001", commitment, {
    paymentAttemptId: "attempt-001",
    invoiceId: "invoice-001",
    eventId: "chain-event-001",
    signature: TEST_SIGNATURE,
    outerInstructionIndex: 0,
    innerInstructionIndex: null,
    mint: TEST_MINT,
    amountBaseUnits: "12500000",
    commitment,
  });
}

function lifecycle<
  Type extends LifecycleEvent["type"],
  Event extends Extract<LifecycleEvent, { readonly type: Type }>,
>(
  type: Type,
  objectType: Event["object"]["type"],
  objectId: string,
  statusAtOccurrence: string,
  data: Event["data"],
): Event {
  return {
    type,
    statusAtOccurrence,
    object: { type: objectType, id: objectId, version: 1 },
    data,
  } as Event;
}
