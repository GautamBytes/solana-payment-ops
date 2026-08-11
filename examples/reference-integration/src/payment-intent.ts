import {
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  loadPaymentFixture,
  parseTransferCheckedEvents,
  PaymentFixtureSchema,
  verifyPayment,
  type VerificationReport,
} from "@payops/core";

export interface ExamplePaymentIntent {
  readonly id: string;
  readonly recipientOwner: string;
  readonly destinationTokenAccount: string;
  readonly mint: string;
  readonly amountBaseUnits: string;
  readonly reference: string;
}

export async function verifyIntentFromFixture(
  intent: ExamplePaymentIntent,
  fixturePath: string,
): Promise<VerificationReport> {
  if (Array.from(intent.id).length < 1 || Array.from(intent.id).length > 128) {
    throw new TypeError(
      "Payment intent ID must contain 1 through 128 code points",
    );
  }
  const source = await loadPaymentFixture(fixturePath);
  const fixture = PaymentFixtureSchema.parse({
    ...source,
    expectation: {
      cluster: "mainnet-beta",
      recipientOwner: intent.recipientOwner,
      destinationTokenAccount: intent.destinationTokenAccount,
      mint: intent.mint,
      tokenProgram: String(LEGACY_TOKEN_PROGRAM_ADDRESS),
      amountBaseUnits: intent.amountBaseUnits,
      decimals: 6,
      reference: intent.reference,
      requiredCommitment: "finalized",
    },
  });
  const transfers = parseTransferCheckedEvents(fixture);
  if (transfers.length !== 1 || transfers[0] === undefined) {
    throw new Error(
      "Reference integration requires exactly one transfer event",
    );
  }
  return verifyPayment(fixture, transfers[0], transfers);
}
