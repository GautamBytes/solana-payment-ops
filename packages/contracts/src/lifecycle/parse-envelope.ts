import { lifecycleEventEnvelopeSchema } from "./schema.js";
import type { LifecycleEventEnvelope } from "./types.js";

export function parseLifecycleEventEnvelope(
  raw: unknown,
): LifecycleEventEnvelope | null {
  try {
    const result = lifecycleEventEnvelopeSchema.safeParse(raw);
    if (!result.success) return null;
    const envelope = result.data;
    if (!identityMatches(envelope)) return null;
    return envelope as LifecycleEventEnvelope;
  } catch {
    return null;
  }
}

function identityMatches(
  envelope: typeof lifecycleEventEnvelopeSchema._output,
): boolean {
  switch (envelope.type) {
    case "invoice.issued":
    case "invoice.cancelled":
    case "invoice.partial":
    case "invoice.paid":
    case "invoice.overpaid":
      return envelope.object.id === envelope.data.invoiceId;
    case "payment.detected":
    case "payment.confirmed":
    case "payment.finalized":
    case "payment.confirmation_revoked":
      return envelope.object.id === envelope.data.paymentAttemptId;
    case "payment.exception_created":
      return envelope.object.id === envelope.data.exceptionId;
    case "refund.prepared":
    case "refund.finalized":
      return envelope.object.id === envelope.data.refundId;
    case "evidence.ready":
      return envelope.object.id === envelope.data.evidencePackId;
  }
}
