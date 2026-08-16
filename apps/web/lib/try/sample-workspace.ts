import type { TryPaymentDecision, TryWorkspace } from "./types";

const recipient = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const reference = "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4";

const decisions: readonly TryPaymentDecision[] = [
  {
    id: "sample-matched",
    invoiceReference: "INV-0421",
    state: "matched",
    exceptionLabel: null,
    assetSymbol: "USDC",
    amountTokens: "12.500000",
    amountBaseUnits: "12500000",
    signature:
      "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T",
    slot: 345678901,
    finalizedAt: "2026-08-06T07:06:40.000Z",
    recipient,
    reference,
    sourceFixture: "fixtures/v0.1/usdc-transfer-checked-finalized.json",
    evidence: [
      {
        stage: "detect",
        label: "Finalized transfer observed",
        outcome: "passed",
        detail: "Slot 345678901",
      },
      {
        stage: "verify",
        label: "Token, recipient, and amount verified",
        outcome: "passed",
        detail: "12.500000 USDC",
      },
      {
        stage: "match",
        label: "Reference matched INV-0421",
        outcome: "passed",
        detail: reference,
      },
      {
        stage: "prove",
        label: "Replayable evidence preserved",
        outcome: "recorded",
        detail: "15 deterministic checks",
      },
    ],
  },
  {
    id: "sample-wrong-destination",
    invoiceReference: "INV-0422",
    state: "exception",
    exceptionLabel: "Wrong destination",
    assetSymbol: "USDC",
    amountTokens: "12.500000",
    amountBaseUnits: "12500000",
    signature:
      "66ha5owWorvkzWaEf4g85Q6E6LEGmppeqQ4RpyDUDmQWr41eyexZwLzcu1Pfq4DhV4EFsv2pLcFXgJrvyxMvBU6q",
    slot: 345678915,
    finalizedAt: "2026-08-06T07:06:55.000Z",
    recipient,
    reference,
    sourceFixture: "fixtures/v0.1/cases/wrong-destination-token-account.json",
    evidence: [
      {
        stage: "detect",
        label: "Finalized transfer observed",
        outcome: "passed",
        detail: "Slot 345678915",
      },
      {
        stage: "verify",
        label: "Destination check failed",
        outcome: "failed",
        detail: "Transfer recipient differs from the invoice",
      },
      {
        stage: "match",
        label: "Invoice left unpaid",
        outcome: "failed",
        detail: "Exception: wrong destination",
      },
      {
        stage: "prove",
        label: "Failure evidence preserved",
        outcome: "recorded",
        detail: "No payment state guessed",
      },
    ],
  },
  {
    id: "sample-partial-amount",
    invoiceReference: "INV-0423",
    state: "exception",
    exceptionLabel: "Amount mismatch",
    assetSymbol: "USDC",
    amountTokens: "12.499999",
    amountBaseUnits: "12499999",
    signature:
      "fRTLbAQ2w1bisJQNUfEavKowvnYSoFxUawyXbBtw7cUDm8bniw9D7tmJCQyNV21CPgqxavGLMzC1Ry5xzKAbbD1",
    slot: 345678917,
    finalizedAt: "2026-08-06T07:06:57.000Z",
    recipient,
    reference,
    sourceFixture: "fixtures/v0.1/cases/partial-base-unit-amount.json",
    evidence: [
      {
        stage: "detect",
        label: "Finalized transfer observed",
        outcome: "passed",
        detail: "Slot 345678917",
      },
      {
        stage: "verify",
        label: "Exact amount check failed",
        outcome: "failed",
        detail: "Expected 12.500000; observed 12.499999",
      },
      {
        stage: "match",
        label: "Invoice left unpaid",
        outcome: "failed",
        detail: "Exception: amount mismatch",
      },
      {
        stage: "prove",
        label: "Failure evidence preserved",
        outcome: "recorded",
        detail: "One base unit difference retained",
      },
    ],
  },
] as const;

export const sampleWorkspace: TryWorkspace = Object.freeze({
  kind: "sample",
  disclosure:
    "Realistic synthetic data. No account, wallet, or funds are involved.",
  summary: {
    invoices: 3,
    matchedPayments: 1,
    exceptions: 2,
    finalizedVolume: "37.499999 USDC",
  },
  decisions,
});
