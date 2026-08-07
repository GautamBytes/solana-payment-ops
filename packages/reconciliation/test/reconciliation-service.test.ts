import { expect, it } from "vitest";
import {
  runReconciliation,
  type FinalizedPaymentEvent,
  type InvoiceRecord,
  type ReconciliationDecision,
  type ReconciliationStore,
} from "../src/index.js";

const invoice: InvoiceRecord = {
  invoiceId: "inv-001",
  customerId: "customer-001",
  expectedMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
  amountBaseUnits: 1_000_000n,
  referenceAddress: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
  issuedAt: new Date("2026-08-01T00:00:00Z"),
  dueAt: new Date("2026-08-15T00:00:00Z"),
  status: "open",
};

const event: FinalizedPaymentEvent = {
  chainEventId: "1",
  eventId: "event-001",
  cluster: "mainnet-beta",
  signature: "signature-001",
  outerInstructionIndex: 0,
  innerInstructionIndex: null,
  mint: invoice.expectedMint,
  destinationTokenAccount: invoice.destinationTokenAccount,
  amountBaseUnits: invoice.amountBaseUnits,
  decimals: 6,
  references: [invoice.referenceAddress],
  blockTime: new Date("2026-08-10T00:00:00Z"),
};

it("persists every deterministic decision and returns stable counts", async () => {
  const recorded: ReconciliationDecision[] = [];
  const completed: string[] = [];
  const store: ReconciliationStore = {
    startRun: async () => "run-001",
    completeRun: async (runId) => {
      completed.push(runId);
    },
    listInvoices: async () => [invoice],
    listFinalizedCandidates: async () => [event],
    recordDecision: async (decision) => {
      recorded.push(decision);
      return true;
    },
  };

  await expect(
    runReconciliation(store, new Date("2026-08-07T00:00:00Z")),
  ).resolves.toEqual({
    candidates: 1,
    allocations: 1,
    exceptions: 0,
    applied: 1,
  });
  expect(recorded).toMatchObject([
    { code: "exact_match", eventId: "event-001" },
  ]);
  expect(completed).toEqual(["run-001"]);
});
