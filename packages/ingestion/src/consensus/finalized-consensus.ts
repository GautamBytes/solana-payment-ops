import { parseTransactionTransfers } from "@payops/core";
import {
  createCanonicalSnapshot,
  createParsingDigest,
} from "../archive/canonical-snapshot.js";
import type {
  ClaimFinalizedConsensusInput,
  FinalizedConsensusState,
  FinalizedConsensusStore,
  FinalizedProviderObservation,
  IngestionErrorCode,
  SolanaRpcPort,
  TransactionStatus,
} from "../domain/types.js";
import { IngestionError } from "../domain/types.js";

export interface FinalizedConsensusDependencies {
  readonly store: FinalizedConsensusStore;
  readonly rpcForProvider:
    | ((providerId: string) => SolanaRpcPort)
    | ((providerId: string) => Promise<SolanaRpcPort>);
}

export interface FinalizedConsensusResult {
  readonly state: FinalizedConsensusState;
  readonly generation: number;
  readonly applied: boolean;
}

interface CompleteEvidence extends FinalizedProviderObservation {
  readonly canonicalDigest: string;
  readonly validFinalized: boolean;
}

interface SafeProviderFailure {
  readonly code: IngestionErrorCode;
  readonly retryable: boolean;
}

type ObservedEvidence = FinalizedProviderObservation & {
  readonly validFinalized: boolean;
};

export class FinalizedConsensusEngine {
  readonly #store: FinalizedConsensusStore;
  readonly #rpcForProvider: FinalizedConsensusDependencies["rpcForProvider"];

  public constructor(dependencies: FinalizedConsensusDependencies) {
    this.#store = dependencies.store;
    this.#rpcForProvider = dependencies.rpcForProvider;
  }

  public async verify(
    input: ClaimFinalizedConsensusInput,
  ): Promise<FinalizedConsensusResult> {
    validateInput(input);
    const claim = await this.#store.claimFinalizedConsensus(input);
    if (claim.kind === "settled") {
      return {
        state: claim.state,
        generation: claim.generation,
        applied: false,
      };
    }
    const observations = await Promise.all(
      [claim.primaryProviderId, claim.secondaryProviderId].map(
        async (providerId) =>
          observeProvider(
            await this.#rpcForProvider(providerId),
            providerId,
            claim.signature,
            input.now,
          ),
      ),
    );
    const [primary, secondary] = observations;
    const state = decideState(primary, secondary);
    return this.#store.completeFinalizedConsensus({
      claim,
      state,
      observations,
    });
  }
}

function validateInput(input: ClaimFinalizedConsensusInput): void {
  if (
    input.primaryProviderId === input.secondaryProviderId ||
    input.primaryProviderId.length < 1 ||
    input.primaryProviderId.length > 64 ||
    input.secondaryProviderId.length < 1 ||
    input.secondaryProviderId.length > 64 ||
    input.signature.length < 32 ||
    input.signature.length > 128 ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw new IngestionError(
      "invalid_configuration",
      "Finalized consensus input is invalid",
      { retryable: false },
    );
  }
}

async function observeProvider(
  rpc: SolanaRpcPort,
  providerId: string,
  signature: string,
  observedAt: Date,
): Promise<ObservedEvidence> {
  const startedAt = performance.now();
  try {
    const [statuses, transaction] = await Promise.all([
      rpc.getSignatureStatuses([signature]),
      rpc.getTransaction(signature, "finalized"),
    ]);
    if (statuses.length !== 1) {
      throw new IngestionError(
        "rpc_invalid_json",
        "Finalized status response count is invalid",
        { retryable: true },
      );
    }
    const status = statuses[0] ?? null;
    if (status === null || transaction === null) {
      return unavailableObservation(providerId, observedAt, startedAt, {
        code: "finality_status_missing",
        retryable: true,
      });
    }
    const snapshotDigest = createCanonicalSnapshot(transaction).digest;
    const parsingDigest = createParsingDigest(transaction);
    const transferIdentityDigest = createCanonicalSnapshot(
      parseTransactionTransfers(transaction)
        .map((transfer) => ({
          ...transfer,
          references: [...transfer.references].sort(),
          unsupportedExtraAccounts: [
            ...transfer.unsupportedExtraAccounts,
          ].sort(),
        }))
        .sort((left, right) =>
          createCanonicalSnapshot(left).canonicalJson.localeCompare(
            createCanonicalSnapshot(right).canonicalJson,
          ),
        ),
    ).digest;
    const statusExecutionDigest = createCanonicalSnapshot(status.err).digest;
    const transactionExecutionDigest = createCanonicalSnapshot(
      transaction.meta.err,
    ).digest;
    const executionDigest = createCanonicalSnapshot({
      status: statusExecutionDigest,
      transaction: transactionExecutionDigest,
    }).digest;
    const finality = `${status.confirmationStatus ?? "null"}/${transaction.commitment}`;
    const canonicalDigest = createCanonicalSnapshot({
      signature: {
        requested: signature,
        status: status.signature,
        transaction: transaction.signature,
      },
      slot: {
        status: status.slot?.toString() ?? null,
        transaction: String(transaction.slot),
      },
      executionDigest,
      finality,
      snapshotDigest,
      parsingDigest,
      transferIdentityDigest,
    }).digest;
    return {
      providerId,
      canonicalDigest,
      snapshotDigest,
      parsingDigest,
      transferIdentityDigest,
      statusSlot: status.slot,
      slot: BigInt(transaction.slot),
      executionState:
        status.err === null && transaction.meta.err === null
          ? "succeeded"
          : "failed",
      executionDigest,
      statusExecutionDigest,
      transactionExecutionDigest,
      finality,
      responseTimeMs: elapsedMilliseconds(startedAt),
      safeErrorCode: null,
      safeErrorRetryable: null,
      observedAt,
      validFinalized:
        status.signature === signature &&
        transaction.signature === signature &&
        status.slot === BigInt(transaction.slot) &&
        statusExecutionDigest === transactionExecutionDigest &&
        status.confirmationStatus === "finalized" &&
        transaction.commitment === "finalized",
    };
  } catch (error) {
    return unavailableObservation(
      providerId,
      observedAt,
      startedAt,
      safeProviderFailure(error),
    );
  }
}

function unavailableObservation(
  providerId: string,
  observedAt: Date,
  startedAt: number,
  error: SafeProviderFailure,
): ObservedEvidence {
  return {
    providerId,
    canonicalDigest: null,
    snapshotDigest: null,
    parsingDigest: null,
    transferIdentityDigest: null,
    statusSlot: null,
    slot: null,
    executionState: null,
    executionDigest: null,
    statusExecutionDigest: null,
    transactionExecutionDigest: null,
    finality: null,
    responseTimeMs: elapsedMilliseconds(startedAt),
    safeErrorCode: error.code,
    safeErrorRetryable: error.retryable,
    observedAt,
    validFinalized: false,
  };
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.min(
    300_000,
    Math.max(0, Math.round(performance.now() - startedAt)),
  );
}

function safeProviderFailure(error: unknown): SafeProviderFailure {
  if (!(error instanceof IngestionError)) {
    return { code: "rpc_transport_error", retryable: true };
  }
  return safeProviderErrorCodes.has(error.code)
    ? { code: error.code, retryable: error.retryable }
    : { code: "rpc_transport_error", retryable: true };
}

const safeProviderErrorCodes = new Set<IngestionErrorCode>([
  "rpc_transport_error",
  "rpc_rate_limited",
  "rpc_invalid_json",
  "rpc_error",
  "rpc_transaction_missing",
  "rpc_signature_conflict",
  "rpc_unsupported_version",
  "rpc_transaction_schema_invalid",
  "finality_status_missing",
]);

function isComplete(
  observation: ObservedEvidence | undefined,
): observation is CompleteEvidence {
  return observation?.canonicalDigest !== null && observation !== undefined;
}

function decideState(
  primary: ObservedEvidence | undefined,
  secondary: ObservedEvidence | undefined,
): FinalizedConsensusState {
  if (
    [primary, secondary].some(
      (observation) =>
        observation?.safeErrorCode === "rpc_signature_conflict" &&
        observation.safeErrorRetryable === false,
    )
  ) {
    return "disagreed";
  }
  if (!isComplete(primary) || !isComplete(secondary)) return "pending";
  return primary.validFinalized &&
    secondary.validFinalized &&
    primary.canonicalDigest === secondary.canonicalDigest
    ? "agreed"
    : "disagreed";
}
