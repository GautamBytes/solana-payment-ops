import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { VerificationReport } from "./domain/types.js";
import {
  loadFixtureManifest,
  MAX_FIXTURE_JSON_BYTES,
  type LoadedFixtureCase,
} from "./fixtures/load-manifest.js";
import {
  PaymentFixtureSchema,
  type PaymentFixture,
} from "./fixtures/schema.js";
import {
  parseTransferCheckedEvents,
  UnsupportedTransferEvidenceError,
} from "./solana/parse-transaction.js";
import { verifyPayment } from "./verify/verify-payment.js";
import { stringifyCanonical } from "./canonical-json.js";

export interface ConformanceReport {
  readonly schemaVersion: "0.1";
  readonly fixtureName: string;
  readonly signature: string;
  readonly passed: boolean;
  readonly reports: readonly VerificationReport[];
}

export type ConformanceCaseErrorCode =
  "invalid_fixture" | "unsupported_transfer_evidence" | "evaluation_failed";

export type ConformanceCaseReport =
  | {
      readonly id: string;
      readonly file: string;
      readonly fixtureDigest: string;
      readonly outcome: "pass" | "verification_failure";
      readonly passed: boolean;
      readonly eventCount: number;
      readonly verifiedCount: number;
      readonly eventIds: readonly string[];
      readonly verificationCodes: readonly string[];
      readonly exceptionCode: string | null;
    }
  | {
      readonly id: string;
      readonly file: string;
      readonly fixtureDigest: string;
      readonly outcome: "parse_failure";
      readonly passed: boolean;
      readonly errorCode: ConformanceCaseErrorCode;
      readonly exceptionCode: null;
    };

export interface ConformanceSuiteReport {
  readonly schemaVersion: "0.1";
  readonly manifestDigest: string;
  readonly passed: boolean;
  readonly cases: readonly ConformanceCaseReport[];
  readonly suiteDigest: string;
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

export async function evaluateManifest(
  manifestPath: string,
): Promise<ConformanceSuiteReport> {
  const loaded = await loadFixtureManifest(manifestPath);
  const cases = loaded.cases.map(evaluateLoadedCase);
  const reportWithoutDigest = {
    schemaVersion: "0.1" as const,
    manifestDigest: loaded.manifestDigest,
    passed: cases.every(({ passed }) => passed),
    cases,
  };
  return {
    ...reportWithoutDigest,
    suiteDigest: digest(stringifyCanonical(reportWithoutDigest)),
  };
}

export async function evaluateConformancePath(
  inputPath: string,
): Promise<ConformanceReport | ConformanceSuiteReport> {
  const handle = await open(inputPath, "r");
  let raw: string;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_FIXTURE_JSON_BYTES) {
      throw new Error(
        "Conformance input must be a JSON file no larger than 2 MiB",
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_FIXTURE_JSON_BYTES) {
      throw new Error(
        "Conformance input must be a JSON file no larger than 2 MiB",
      );
    }
    raw = bytes.toString("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "cases" in value &&
    "schemaVersion" in value
  ) {
    return evaluateManifest(inputPath);
  }
  const fixture = PaymentFixtureSchema.parse(value);
  return evaluateFixture(fixture);
}

function evaluateLoadedCase(loaded: LoadedFixtureCase): ConformanceCaseReport {
  let fixture: PaymentFixture;
  try {
    fixture = PaymentFixtureSchema.parse(
      JSON.parse(loaded.bytes.toString("utf8")),
    );
  } catch {
    return parseFailure(loaded, "invalid_fixture");
  }

  let report: ConformanceReport;
  try {
    report = evaluateFixture(fixture);
  } catch (error) {
    return parseFailure(
      loaded,
      error instanceof UnsupportedTransferEvidenceError
        ? "unsupported_transfer_evidence"
        : "evaluation_failed",
    );
  }

  const actual = {
    eventCount: report.reports.length,
    verifiedCount: report.reports.filter(({ verified }) => verified).length,
    eventIds: report.reports.map(({ eventId }) => eventId),
    verificationCodes: uniqueSorted(
      report.reports.flatMap(({ checks }) =>
        checks.filter(({ passed }) => !passed).map(({ code }) => code),
      ),
    ),
  };
  const expected = loaded.definition.expected;
  const outcome = report.passed ? "pass" : "verification_failure";
  return {
    id: loaded.definition.id,
    file: loaded.definition.file,
    fixtureDigest: loaded.digest,
    outcome,
    passed:
      (expected.outcome === "pass" ||
        expected.outcome === "verification_failure") &&
      outcome === expected.outcome &&
      actual.eventCount === expected.eventCount &&
      actual.verifiedCount === expected.verifiedCount &&
      equalArrays(actual.eventIds, expected.eventIds) &&
      equalArrays(
        actual.verificationCodes,
        uniqueSorted(expected.verificationCodes),
      ),
    exceptionCode:
      expected.outcome === "parse_failure" ? null : expected.exceptionCode,
    ...actual,
  };
}

function parseFailure(
  loaded: LoadedFixtureCase,
  errorCode: ConformanceCaseErrorCode,
): ConformanceCaseReport {
  const expected = loaded.definition.expected;
  return {
    id: loaded.definition.id,
    file: loaded.definition.file,
    fixtureDigest: loaded.digest,
    outcome: "parse_failure",
    passed:
      expected.outcome === "parse_failure" &&
      expected.parseFailureCode === errorCode,
    errorCode,
    exceptionCode: null,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function equalArrays(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
