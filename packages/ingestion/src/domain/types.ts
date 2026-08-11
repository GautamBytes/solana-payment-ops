import type { ParsedTransfer, RpcTransactionEnvelope } from "@payops/core";

export type SolanaCluster = "mainnet-beta" | "devnet" | "localnet";
export type Commitment = "confirmed" | "finalized";
export type RepresentationClass =
  "pending" | "parsed" | "irrelevant" | "failed_transaction" | "quarantined";
export type FinalityState =
  | "detected"
  | "confirmed"
  | "finalized"
  | "failed"
  | "reverted"
  | "quarantined";

export type IngestionErrorCode =
  | "rpc_transport_error"
  | "rpc_rate_limited"
  | "rpc_invalid_json"
  | "rpc_error"
  | "rpc_transaction_missing"
  | "rpc_page_no_progress"
  | "rpc_page_order_invalid"
  | "rpc_signature_conflict"
  | "rpc_unsupported_version"
  | "rpc_transaction_schema_invalid"
  | "raw_digest_conflict"
  | "event_identity_conflict"
  | "database_unavailable"
  | "database_serialization_failure"
  | "cursor_compare_failed"
  | "finality_status_missing"
  | "finality_content_conflict"
  | "invalid_configuration"
  | "worker_busy";

export class IngestionError extends Error {
  public readonly code: IngestionErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: IngestionErrorCode,
    message: string,
    options: { readonly retryable: boolean; readonly cause?: unknown },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "IngestionError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

export interface CanonicalSnapshot {
  readonly canonicalJson: string;
  readonly byteLength: number;
  readonly digest: string;
}

export interface AddressSignature {
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTime: bigint | null;
  readonly err: unknown | null;
  readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export interface SignaturePageRequest {
  readonly address: string;
  readonly commitment: "confirmed";
  readonly limit: number;
  readonly before?: string;
  readonly minContextSlot?: bigint;
}

export interface TransactionStatus {
  readonly signature: string;
  readonly slot: bigint | null;
  readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  readonly err: unknown | null;
}

export interface SolanaRpcPort {
  getSignaturesForAddress(
    request: SignaturePageRequest,
  ): Promise<readonly AddressSignature[]>;
  getTransaction(
    signature: string,
    commitment: Commitment,
  ): Promise<RpcTransactionEnvelope | null>;
  getSignatureStatuses(
    signatures: readonly string[],
  ): Promise<readonly (TransactionStatus | null)[]>;
  getSlot(commitment: Commitment): Promise<bigint>;
}

export interface ProviderRecord {
  readonly id: string;
  readonly cluster: SolanaCluster;
  readonly endpointEnv: string;
  readonly endpointLabel: string;
}

export interface WatchTarget {
  readonly id: string;
  readonly providerId: string;
  readonly cluster: SolanaCluster;
  readonly address: string;
  readonly cutoverSlot: bigint;
  readonly cutoverSignature: string | null;
  readonly overlapSlots: bigint;
  readonly committedHeadSlot: bigint | null;
  readonly committedHeadSignature: string | null;
  readonly coverage: "complete" | "incomplete";
}

export interface SyncLock {
  release(): Promise<void>;
}

export interface StartSyncRunInput {
  readonly providerId: string;
  readonly watchTargetId: string;
  readonly startedAt: Date;
  readonly startingHeadSignature: string | null;
  readonly startingHeadSlot: bigint | null;
  readonly capturedHead: AddressSignature | null;
}

export interface RecordPageInput {
  readonly runId: string;
  readonly pageNumber: number;
  readonly before: string | null;
  readonly signatures: readonly AddressSignature[];
  readonly digest: string;
}

export interface RecordRepresentationInput {
  readonly runId: string;
  readonly providerId: string;
  readonly watchTargetId: string;
  readonly discovered: AddressSignature;
  readonly classification: RepresentationClass;
  readonly snapshot: CanonicalSnapshot | null;
  readonly transaction: RpcTransactionEnvelope | null;
  readonly transfers: readonly ParsedTransfer[];
  readonly parserVersion: string;
  readonly observedAt: Date;
  readonly quarantineCode?: IngestionErrorCode;
  readonly quarantineMessage?: string;
}

export interface RecordRepresentationResult {
  readonly signatureInserted: boolean;
  readonly eventsInserted: number;
  readonly quarantineInserted: boolean;
}

export interface RecordRetryInput {
  readonly runId: string | null;
  readonly providerId: string;
  readonly watchTargetId: string;
  readonly signature: string | null;
  readonly operation: "page" | "transaction" | "storage" | "finality";
  readonly code: IngestionErrorCode;
  readonly message: string;
  readonly now: Date;
  readonly finalityClaimToken?: string;
  readonly finalityClaimState?: "detected" | "confirmed";
}

export interface ResolveRetryInput {
  readonly providerId: string;
  readonly watchTargetId: string;
  readonly signature: string | null;
  readonly operation: "page" | "transaction" | "storage";
  readonly resolvedAt: Date;
}

export interface InspectSignatureOptions {
  readonly includeRaw?: boolean;
}

export interface CompleteSyncRunInput {
  readonly runId: string;
  readonly watchTargetId: string;
  readonly startingHeadSignature: string | null;
  readonly capturedHead: AddressSignature | null;
  readonly completedAt: Date;
  readonly result: "complete" | "incomplete";
  readonly coverage: "complete" | "incomplete";
  readonly advanceCursor: boolean;
  readonly counts: {
    readonly pagesRead: number;
    readonly signaturesDiscovered: number;
    readonly signaturesStored: number;
    readonly eventsStored: number;
    readonly retriesCreated: number;
    readonly quarantinesCreated: number;
  };
  readonly errorCode?: IngestionErrorCode;
}

export interface FinalityCandidate {
  readonly providerId: string;
  readonly watchTargetId: string;
  readonly cluster: SolanaCluster;
  readonly signature: string;
  readonly slot: bigint;
  readonly state: "detected" | "confirmed";
  readonly confirmedDigest: string | null;
  readonly missingObservationCount: number;
  readonly firstMissingFinalizedSlot: bigint | null;
  readonly claimToken: string;
  readonly hasFinalizedSnapshot: boolean;
}

export interface RecordFinalityObservationInput {
  readonly candidate: FinalityCandidate;
  readonly observedStatus: TransactionStatus | null;
  readonly observedAt: Date;
  readonly contextSlot: bigint;
  readonly responseDigest: string;
  readonly finalizedSnapshot: CanonicalSnapshot | null;
  readonly nextState: FinalityState;
  readonly code?: IngestionErrorCode;
  readonly blockingRetry?: boolean;
}

export interface RecordFinalityObservationResult {
  readonly applied: boolean;
  readonly state: FinalityState;
}

export interface AddProviderInput extends ProviderRecord {}

export interface AddWatchTargetInput {
  readonly id: string;
  readonly providerId: string;
  readonly cluster: SolanaCluster;
  readonly address: string;
  readonly cutoverSlot: bigint;
  readonly cutoverSignature: string | null;
  readonly overlapSlots: bigint;
  readonly createdAt: Date;
}

export interface WatchCoverageSummary {
  readonly watchTargetId: string;
  readonly coverage: "complete" | "incomplete";
  readonly capturedHeadSlot: string | null;
  readonly committedHeadSlot: string | null;
  readonly signatures: number;
  readonly finalized: number;
  readonly pendingFinality: number;
  readonly retriesOpen: number;
  readonly quarantinesOpen: number;
}

export interface IngestionAuditStore {
  getWatchCoverageSummaries(
    watchTargetIds: readonly string[],
  ): Promise<readonly WatchCoverageSummary[]>;
}

export interface IngestionStore {
  tryAcquireSyncLock(
    providerId: string,
    watchTargetId: string,
  ): Promise<SyncLock | null>;
  getProvider(providerId: string): Promise<ProviderRecord | null>;
  addProvider(input: AddProviderInput): Promise<ProviderRecord>;
  getWatchTarget(watchTargetId: string): Promise<WatchTarget | null>;
  addWatchTarget(input: AddWatchTargetInput): Promise<WatchTarget>;
  startSyncRun(input: StartSyncRunInput): Promise<string>;
  recordPage(input: RecordPageInput): Promise<void>;
  recordRepresentation(
    input: RecordRepresentationInput,
  ): Promise<RecordRepresentationResult>;
  recordRetry(input: RecordRetryInput): Promise<boolean>;
  resolveRetry(input: ResolveRetryInput): Promise<boolean>;
  completeSyncRun(input: CompleteSyncRunInput): Promise<boolean>;
  claimFinalityCandidates(
    providerId: string,
    limit: number,
    now: Date,
  ): Promise<readonly FinalityCandidate[]>;
  recordFinalityObservation(
    input: RecordFinalityObservationInput,
  ): Promise<RecordFinalityObservationResult>;
  inspectSignature(
    signature: string,
    options?: InspectSignatureOptions,
  ): Promise<unknown | null>;
  close(): Promise<void>;
}

export interface SyncWatchTargetInput {
  readonly providerId: string;
  readonly watchTargetId: string;
  readonly now: Date;
}

export interface SyncReport {
  readonly runId: string;
  readonly capturedHeadSignature: string | null;
  readonly capturedHeadSlot: string | null;
  readonly pagesRead: number;
  readonly signaturesDiscovered: number;
  readonly signaturesStored: number;
  readonly eventsStored: number;
  readonly retriesCreated: number;
  readonly quarantinesCreated: number;
  readonly cursorAdvanced: boolean;
  readonly result: "complete" | "incomplete" | "busy";
}

export interface RefreshFinalityInput {
  readonly providerId: string;
  readonly limit: number;
  readonly now: Date;
}

export interface FinalityReport {
  readonly observationsChecked: number;
  readonly finalized: number;
  readonly failed: number;
  readonly reverted: number;
  readonly deferred: number;
  readonly quarantined: number;
  readonly retriesCreated: number;
}
