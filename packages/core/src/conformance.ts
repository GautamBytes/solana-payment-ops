import type { VerificationReport } from "./domain/types.js";
import type { PaymentFixture } from "./fixtures/schema.js";
import { parseTransferCheckedEvents } from "./solana/parse-transaction.js";
import { verifyPayment } from "./verify/verify-payment.js";

export interface ConformanceReport {
  readonly schemaVersion: "0.1";
  readonly fixtureName: string;
  readonly signature: string;
  readonly passed: boolean;
  readonly reports: readonly VerificationReport[];
}

export function evaluateFixture(fixture: PaymentFixture): ConformanceReport {
  const transfers = parseTransferCheckedEvents(fixture);
  const reports = transfers.map((transfer) =>
    verifyPayment(fixture, transfer, transfers),
  );
  const verifiedReportCount = reports.filter(
    (report) => report.verified,
  ).length;

  return {
    schemaVersion: "0.1",
    fixtureName: fixture.name,
    signature: fixture.rpcTransaction.signature,
    passed: verifiedReportCount === 1,
    reports,
  };
}
