const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export function nextStatusPollDelay(input: {
  readonly elapsedMs: number;
  readonly consecutiveFailures: number;
  readonly random: number;
}): number {
  if (
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs < 0 ||
    !Number.isInteger(input.consecutiveFailures) ||
    input.consecutiveFailures < 0 ||
    !Number.isFinite(input.random) ||
    input.random < 0 ||
    input.random >= 1
  ) {
    throw new TypeError("Polling inputs are invalid");
  }
  const cadence =
    input.elapsedMs < MINUTE
      ? 2 * SECOND
      : input.elapsedMs < 10 * MINUTE
        ? 5 * SECOND
        : 15 * SECOND;
  const backedOff = Math.min(
    15 * SECOND,
    cadence * 2 ** Math.min(input.consecutiveFailures, 3),
  );
  const jitter = Math.floor(backedOff * 0.1 * input.random);
  return backedOff + jitter;
}

export function statusAnnouncement(status: string): string {
  switch (status) {
    case "detected":
      return "Payment detected on Solana.";
    case "confirmed":
      return "Payment confirmed. Waiting for finality.";
    case "finalized":
      return "Payment finalized. Updating the invoice.";
    case "paid":
      return "Invoice paid.";
    case "confirmation_revoked":
      return "Confirmation was revoked. Waiting for finalized payment evidence.";
    case "exception":
      return "Payment needs merchant review.";
    default:
      return "";
  }
}
