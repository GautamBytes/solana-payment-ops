import {
  createCanonicalSnapshot,
  createParsingDigest,
} from "../archive/canonical-snapshot.js";
import type {
  FinalityCandidate,
  FinalityReport,
  FinalityState,
  IngestionErrorCode,
  IngestionStore,
  RefreshFinalityInput,
  SolanaRpcPort,
  TransactionStatus,
} from "../domain/types.js";
import { IngestionError } from "../domain/types.js";

export interface FinalityEngine {
  refresh(input: RefreshFinalityInput): Promise<FinalityReport>;
}

export interface FinalityDependencies {
  readonly rpc: SolanaRpcPort;
  readonly store: IngestionStore;
}

function statusDigest(
  signature: string,
  status: TransactionStatus | null,
  contextSlot: bigint,
): string {
  return createCanonicalSnapshot({
    signature,
    contextSlot: contextSlot.toString(),
    status:
      status === null
        ? null
        : {
            slot: status.slot?.toString() ?? null,
            confirmationStatus: status.confirmationStatus,
            err: status.err,
          },
  }).digest;
}

function shouldTestReversion(
  candidate: FinalityCandidate,
  contextSlot: bigint,
): boolean {
  const missingCount = candidate.missingObservationCount + 1;
  const firstMissingSlot = candidate.firstMissingFinalizedSlot ?? contextSlot;
  return (
    missingCount >= 3 &&
    contextSlot >= firstMissingSlot + 64n &&
    contextSlot >= candidate.slot + 64n
  );
}

function asIngestionError(error: unknown): IngestionError {
  if (error instanceof IngestionError) return error;
  return new IngestionError(
    "rpc_transport_error",
    "Solana RPC finality request failed",
    { retryable: true, cause: error },
  );
}

async function recordFinalityRetry(
  store: IngestionStore,
  candidate: FinalityCandidate,
  error: IngestionError,
  now: Date,
): Promise<boolean> {
  return store.recordRetry({
    runId: null,
    providerId: candidate.providerId,
    watchTargetId: candidate.watchTargetId,
    signature: candidate.signature,
    operation: "finality",
    code: error.code,
    message: `Finality operation failed with ${error.code}`,
    now,
    finalityClaimToken: candidate.claimToken,
    finalityClaimState: candidate.state,
  });
}

export function createFinalityEngine(
  dependencies: FinalityDependencies,
): FinalityEngine {
  const { rpc, store } = dependencies;
  return {
    async refresh(input: RefreshFinalityInput): Promise<FinalityReport> {
      if (input.limit < 1 || input.limit > 256) {
        throw new IngestionError(
          "invalid_configuration",
          "Finality limit must be between 1 and 256",
          { retryable: false },
        );
      }
      const candidates = await store.claimFinalityCandidates(
        input.providerId,
        input.limit,
        input.now,
      );
      const report = {
        observationsChecked: candidates.length,
        finalized: 0,
        failed: 0,
        reverted: 0,
        deferred: 0,
        quarantined: 0,
        retriesCreated: 0,
      };
      if (candidates.length === 0) {
        return report;
      }

      let contextSlot: bigint;
      let statuses: readonly (TransactionStatus | null)[];
      try {
        contextSlot = await rpc.getSlot("finalized");
        statuses = await rpc.getSignatureStatuses(
          candidates.map(({ signature }) => signature),
        );
      } catch (error) {
        const ingestionError = asIngestionError(error);
        await Promise.all(
          candidates.map((candidate) =>
            recordFinalityRetry(store, candidate, ingestionError, input.now),
          ),
        );
        throw ingestionError;
      }
      if (statuses.length !== candidates.length) {
        const error = new IngestionError(
          "rpc_invalid_json",
          "Finality status count does not match requested signatures",
          { retryable: true },
        );
        await Promise.all(
          candidates.map((candidate) =>
            recordFinalityRetry(store, candidate, error, input.now),
          ),
        );
        throw error;
      }

      for (const [index, candidate] of candidates.entries()) {
        const status = statuses[index] ?? null;
        let nextState: FinalityState = candidate.state;
        let code: IngestionErrorCode | undefined;
        let finalizedSnapshot = null;
        let blockingRetry = false;

        if (status === null) {
          code = "finality_status_missing";
          if (
            shouldTestReversion(candidate, contextSlot) &&
            !candidate.hasFinalizedSnapshot
          ) {
            try {
              const finalizedTransaction = await rpc.getTransaction(
                candidate.signature,
                "finalized",
              );
              if (finalizedTransaction === null) {
                nextState = "reverted";
              } else {
                finalizedSnapshot =
                  createCanonicalSnapshot(finalizedTransaction);
              }
            } catch (error) {
              const ingestionError = asIngestionError(error);
              code = ingestionError.code;
              if (ingestionError.retryable) {
                const retryCreated = await recordFinalityRetry(
                  store,
                  candidate,
                  ingestionError,
                  input.now,
                );
                report.retriesCreated += Number(retryCreated);
                blockingRetry = retryCreated;
              } else {
                nextState = "quarantined";
              }
            }
          }
        } else if (status.err !== null) {
          nextState = "failed";
        } else if (status.confirmationStatus === "finalized") {
          try {
            const finalizedTransaction = await rpc.getTransaction(
              candidate.signature,
              "finalized",
            );
            if (finalizedTransaction === null) {
              code = "finality_status_missing";
              const retryCreated = await recordFinalityRetry(
                store,
                candidate,
                new IngestionError(
                  "finality_status_missing",
                  "Finalized transaction history is temporarily unavailable",
                  { retryable: true },
                ),
                input.now,
              );
              report.retriesCreated += Number(retryCreated);
              blockingRetry = retryCreated;
            } else {
              finalizedSnapshot = createCanonicalSnapshot(finalizedTransaction);
              const finalizedDigest = createParsingDigest(finalizedTransaction);
              if (
                candidate.confirmedDigest === null ||
                candidate.confirmedDigest !== finalizedDigest
              ) {
                nextState = "quarantined";
                code = "finality_content_conflict";
              } else {
                nextState = "finalized";
              }
            }
          } catch (error) {
            const ingestionError = asIngestionError(error);
            code = ingestionError.code;
            if (ingestionError.retryable) {
              const retryCreated = await recordFinalityRetry(
                store,
                candidate,
                ingestionError,
                input.now,
              );
              report.retriesCreated += Number(retryCreated);
              blockingRetry = retryCreated;
            } else {
              nextState = "quarantined";
            }
          }
        } else {
          nextState =
            status.confirmationStatus === "confirmed"
              ? "confirmed"
              : candidate.state;
        }

        const result = await store.recordFinalityObservation({
          candidate,
          observedStatus: status,
          observedAt: input.now,
          contextSlot,
          responseDigest: statusDigest(
            candidate.signature,
            status,
            contextSlot,
          ),
          finalizedSnapshot,
          nextState,
          blockingRetry,
          ...(code === undefined ? {} : { code }),
        });
        if (!result.applied) {
          report.deferred += 1;
        } else if (result.state === "finalized") {
          report.finalized += 1;
        } else if (result.state === "failed") {
          report.failed += 1;
        } else if (result.state === "reverted") {
          report.reverted += 1;
        } else if (result.state === "quarantined") {
          report.quarantined += 1;
        } else {
          report.deferred += 1;
        }
      }
      return report;
    },
  };
}
