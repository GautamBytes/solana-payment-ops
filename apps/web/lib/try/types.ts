export type TryDecisionState = "matched" | "exception";
export type TryEvidenceStage = "detect" | "verify" | "match" | "prove";

export interface TryEvidenceStep {
  readonly stage: TryEvidenceStage;
  readonly label: string;
  readonly outcome: "passed" | "failed" | "recorded";
  readonly detail: string;
}

export interface TryPaymentDecision {
  readonly id: string;
  readonly invoiceReference: string;
  readonly state: TryDecisionState;
  readonly exceptionLabel: string | null;
  readonly assetSymbol: "USDC" | "USDT";
  readonly amountTokens: string;
  readonly amountBaseUnits: string;
  readonly signature: string;
  readonly slot: number;
  readonly finalizedAt: string;
  readonly recipient: string;
  readonly reference: string;
  readonly sourceFixture: string;
  readonly evidence: readonly TryEvidenceStep[];
}

export interface TryWorkspace {
  readonly kind: "sample";
  readonly disclosure: string;
  readonly summary: {
    readonly invoices: number;
    readonly matchedPayments: number;
    readonly exceptions: number;
    readonly finalizedVolume: string;
  };
  readonly decisions: readonly TryPaymentDecision[];
}
