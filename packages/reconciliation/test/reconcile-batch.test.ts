import { expect, it } from "vitest";
import {
  reconcileBatch,
  type FinalizedPaymentEvent,
  type InvoiceRecord,
} from "../src/index.js";

const invoice: InvoiceRecord = {
  invoiceId: "inv-001",
  customerId: "customer-001",
  expectedMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
  amountBaseUnits: 1_000_000n,
  referenceAddress: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
  issuedAt: new Date("2026-08-01T00:00:00.000Z"),
  dueAt: new Date("2026-08-15T00:00:00.000Z"),
  status: "open",
};

function payment(eventId: string): FinalizedPaymentEvent {
  return {
    chainEventId: eventId,
    eventId,
    cluster: "mainnet-beta",
    signature: eventId,
    outerInstructionIndex: 0,
    innerInstructionIndex: null,
    mint: invoice.expectedMint,
    destinationTokenAccount: invoice.destinationTokenAccount,
    amountBaseUnits: invoice.amountBaseUnits,
    decimals: 6,
    references: [invoice.referenceAddress],
    blockTime: new Date("2026-08-10T00:00:00.000Z"),
  };
}

it("returns decisions in stable event identity order without mutating inputs", () => {
  const events = [payment("event-b"), payment("event-a")];
  const decisions = reconcileBatch(events, [invoice]);

  expect(decisions.map((decision) => decision.eventId)).toEqual([
    "event-a",
    "event-b",
  ]);
  expect(events.map((entry) => entry.eventId)).toEqual(["event-b", "event-a"]);
});
