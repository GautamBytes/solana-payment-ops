export type PilotErrorCode =
  | "invalid_manifest"
  | "invoice_digest_mismatch"
  | "unsafe_manifest_path"
  | "invalid_configuration"
  | "database_unavailable"
  | "audit_incomplete"
  | "artifact_write_failed";

export class PilotError extends Error {
  public readonly code: PilotErrorCode;
  public readonly retryable: boolean;

  public constructor(code: PilotErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "PilotError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PilotManifest {
  readonly schemaVersion: "0.1";
  readonly pilotId: string;
  readonly provider: {
    readonly id: string;
    readonly cluster: "mainnet-beta";
    readonly endpointEnv: string;
    readonly endpointLabel: string;
  };
  readonly watches: readonly {
    readonly id: string;
    readonly tokenAccount: string;
    readonly cutoverSlot: string;
    readonly cutoverSignature: string | null;
    readonly overlapSlots: string;
  }[];
  readonly invoices: {
    readonly csvPath: string;
    readonly expectedSha256: string;
  };
  readonly finality: {
    readonly batchSize: number;
    readonly maxPasses: number;
  };
  readonly reporting: {
    readonly pseudonymizationSecretEnv: string;
  };
}

export interface ParsedPilotManifest {
  readonly manifest: PilotManifest;
  readonly canonicalJson: string;
  readonly digest: string;
  readonly invoiceCsvPath: string;
}

export type PilotStage =
  | "configure"
  | "import_invoices"
  | "sync"
  | "finality"
  | "reconcile"
  | "report";

export const PILOT_STAGES: readonly PilotStage[] = [
  "configure",
  "import_invoices",
  "sync",
  "finality",
  "reconcile",
  "report",
];

export type AuditWarningCode =
  | "coverage_incomplete"
  | "finality_pending"
  | "open_retries"
  | "open_quarantines"
  | "unclassified_finalized_value"
  | "audit_busy";

export interface AuditArtifact {
  readonly audience: "private" | "redacted";
  readonly format: "json" | "csv" | "html";
  readonly path: string;
  readonly contentDigest: string;
  readonly byteLength: number;
}

export interface AuditArtifactSet {
  readonly warnings: readonly AuditWarningCode[];
  readonly privateArtifacts: readonly AuditArtifact[];
  readonly redactedArtifacts: readonly AuditArtifact[];
}

export interface AuditReportRow {
  readonly invoiceId: string | null;
  readonly customerId: string | null;
  readonly status: "open" | "matched" | "exception" | "unapplied";
  readonly expectedMint: string;
  readonly amountBaseUnits: string;
  readonly eventId: string | null;
  readonly ruleCode: string | null;
}

export interface AuditReportV01 {
  readonly schemaVersion: "0.1";
  readonly runId: string;
  readonly generatedAt: string;
  readonly coverage: readonly {
    readonly watchTargetId: string;
    readonly coverage: "complete" | "incomplete";
    readonly capturedHeadSlot: string | null;
    readonly committedHeadSlot: string | null;
    readonly signatures: number;
    readonly finalized: number;
    readonly pendingFinality: number;
    readonly retriesOpen: number;
    readonly quarantinesOpen: number;
  }[];
  readonly totals: {
    readonly invoices: number;
    readonly finalizedEvents: number;
    readonly exactMatches: number;
    readonly exceptions: number;
    readonly unapplied: number;
  };
  readonly exceptionsByCode: Readonly<Record<string, number>>;
  readonly warnings: readonly AuditWarningCode[];
  readonly rows: readonly AuditReportRow[];
}

export interface RunShadowAuditInput {
  readonly manifest: PilotManifest;
  readonly manifestCanonicalJson: string;
  readonly manifestDigest: string;
  readonly invoiceCsvPath: string;
  readonly privateOutputDirectory: string;
  readonly redactedOutputDirectory: string;
  readonly now: () => Date;
}

export interface RunShadowAuditResult {
  readonly runId: string;
  readonly state: "complete" | "incomplete";
  readonly resumed: boolean;
  readonly warnings: readonly AuditWarningCode[];
  readonly privateArtifacts: readonly AuditArtifact[];
  readonly redactedArtifacts: readonly AuditArtifact[];
}
