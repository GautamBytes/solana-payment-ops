import { describe, expect, it } from "vitest";
import {
  reconcileEvent,
  type FinalizedPaymentEvent,
  type InvoiceRecord,
} from "../src/index.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DESTINATION = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const OTHER_DESTINATION = "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e";
const REFERENCE = "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4";
const REFERENCE_2 = "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw";

function invoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    invoiceId: "inv-001",
    customerId: "customer-001",
    expectedMint: USDC,
    destinationTokenAccount: DESTINATION,
    amountBaseUnits: 12_500_000n,
    referenceAddress: REFERENCE,
    issuedAt: new Date("2026-08-01T00:00:00.000Z"),
    dueAt: new Date("2026-08-15T00:00:00.000Z"),
    status: "open",
    ...overrides,
  };
}

function event(
  overrides: Partial<FinalizedPaymentEvent> = {},
): FinalizedPaymentEvent {
  return {
    chainEventId: "42",
    eventId: "mainnet-beta:signature:0:outer",
    cluster: "mainnet-beta",
    signature: "signature",
    outerInstructionIndex: 0,
    innerInstructionIndex: null,
    mint: USDC,
    destinationTokenAccount: DESTINATION,
    amountBaseUnits: 12_500_000n,
    decimals: 6,
    references: [REFERENCE],
    blockTime: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("reconcileEvent", () => {
  it("allocates an exact finalized reference match", () => {
    expect(reconcileEvent(event(), [invoice()])).toMatchObject({
      kind: "allocation",
      code: "exact_match",
      invoiceId: "inv-001",
      ruleVersion: "0.1",
    });
  });

  it.each([
    ["missing_reference", event({ references: [] }), [invoice()]],
    ["unknown_reference", event({ references: [REFERENCE_2] }), [invoice()]],
    [
      "ambiguous_reference",
      event({ references: [REFERENCE, REFERENCE_2] }),
      [
        invoice(),
        invoice({ invoiceId: "inv-002", referenceAddress: REFERENCE_2 }),
      ],
    ],
    ["duplicate_payment", event(), [invoice({ status: "matched" })]],
    ["wrong_asset", event({ mint: USDT }), [invoice()]],
    [
      "wrong_destination",
      event({ destinationTokenAccount: OTHER_DESTINATION }),
      [invoice()],
    ],
    ["missing_block_time", event({ blockTime: null }), [invoice()]],
    [
      "before_issue",
      event({ blockTime: new Date("2026-07-31T23:59:59.000Z") }),
      [invoice()],
    ],
    [
      "late_payment",
      event({ blockTime: new Date("2026-08-16T00:00:00.000Z") }),
      [invoice()],
    ],
    ["partial_payment", event({ amountBaseUnits: 12_499_999n }), [invoice()]],
    ["excess_payment", event({ amountBaseUnits: 12_500_001n }), [invoice()]],
  ] as const)("creates %s instead of allocating", (code, payment, invoices) => {
    expect(reconcileEvent(payment, invoices)).toMatchObject({
      kind: "exception",
      code,
      ruleVersion: "0.1",
    });
  });

  it("applies wrong asset before amount comparison", () => {
    expect(
      reconcileEvent(event({ mint: USDT, amountBaseUnits: 1n }), [invoice()]),
    ).toMatchObject({ code: "wrong_asset" });
  });
});
