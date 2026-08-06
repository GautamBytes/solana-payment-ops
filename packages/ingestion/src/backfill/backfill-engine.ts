import {
  parseTransactionTransfers,
  UnsupportedTransferEvidenceError,
} from "@payops/core";
import { createCanonicalSnapshot } from "../archive/canonical-snapshot.js";
import type {
  AddressSignature,
  IngestionErrorCode,
  IngestionStore,
  SolanaRpcPort,
  SyncReport,
  SyncWatchTargetInput,
  WatchTarget,
} from "../domain/types.js";
import { IngestionError } from "../domain/types.js";

export interface BackfillEngine {
  syncWatchTarget(input: SyncWatchTargetInput): Promise<SyncReport>;
}

export interface BackfillDependencies {
  readonly rpc: SolanaRpcPort;
  readonly store: IngestionStore;
  readonly pageLimit?: number;
  readonly parserVersion?: string;
}

interface DiscoveredWithOrder {
  readonly value: AddressSignature;
  readonly order: number;
}

function safeMessage(code: IngestionErrorCode): string {
  return `Ingestion operation failed with ${code}`;
}

function overlapFloor(target: WatchTarget): bigint {
  if (target.committedHeadSlot === null) {
    return target.cutoverSlot;
  }
  const overlap =
    target.committedHeadSlot > target.overlapSlots
      ? target.committedHeadSlot - target.overlapSlots
      : 0n;
  return overlap > target.cutoverSlot ? overlap : target.cutoverSlot;
}

function pageDigest(signatures: readonly AddressSignature[]): string {
  return createCanonicalSnapshot(
    signatures.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot.toString(),
      blockTime: entry.blockTime?.toString() ?? null,
      err: entry.err,
      confirmationStatus: entry.confirmationStatus,
    })),
  ).digest;
}

function asIngestionError(error: unknown): IngestionError {
  if (error instanceof IngestionError) {
    return error;
  }
  return new IngestionError(
    "rpc_transaction_schema_invalid",
    "Transaction could not be represented safely",
    { retryable: false, cause: error },
  );
}

function asStorageError(error: unknown): IngestionError {
  if (error instanceof IngestionError) {
    return error;
  }
  return new IngestionError(
    "database_unavailable",
    "Database operation failed",
    { retryable: true, cause: error },
  );
}

function isStorageError(error: IngestionError): boolean {
  return (
    error.code === "database_unavailable" ||
    error.code === "database_serialization_failure" ||
    error.code === "cursor_compare_failed"
  );
}

export function createBackfillEngine(
  dependencies: BackfillDependencies,
): BackfillEngine {
  const { rpc, store } = dependencies;
  const pageLimit = dependencies.pageLimit ?? 1000;
  const parserVersion = dependencies.parserVersion ?? "0.2.0";
  if (pageLimit < 1 || pageLimit > 1000) {
    throw new IngestionError(
      "invalid_configuration",
      "Backfill page limit must be between 1 and 1000",
      { retryable: false },
    );
  }

  return {
    async syncWatchTarget(input: SyncWatchTargetInput): Promise<SyncReport> {
      const lock = await store.tryAcquireSyncLock(
        input.providerId,
        input.watchTargetId,
      );
      if (lock === null) {
        return {
          runId: "busy",
          capturedHeadSignature: null,
          capturedHeadSlot: null,
          pagesRead: 0,
          signaturesDiscovered: 0,
          signaturesStored: 0,
          eventsStored: 0,
          retriesCreated: 0,
          quarantinesCreated: 0,
          cursorAdvanced: false,
          result: "busy",
        };
      }

      try {
        const [provider, target] = await Promise.all([
          store.getProvider(input.providerId),
          store.getWatchTarget(input.watchTargetId),
        ]);
        if (
          provider === null ||
          target === null ||
          target.providerId !== provider.id ||
          target.cluster !== provider.cluster
        ) {
          throw new IngestionError(
            "invalid_configuration",
            "Provider and watch target configuration do not match",
            { retryable: false },
          );
        }

        const headPage = await rpc.getSignaturesForAddress({
          address: target.address,
          commitment: "confirmed",
          limit: 1,
        });
        const capturedHead = headPage[0] ?? null;
        const runId = await store.startSyncRun({
          providerId: provider.id,
          watchTargetId: target.id,
          startedAt: input.now,
          startingHeadSignature: target.committedHeadSignature,
          startingHeadSlot: target.committedHeadSlot,
          capturedHead,
        });
        const counts = {
          pagesRead: 0,
          signaturesDiscovered: 0,
          signaturesStored: 0,
          eventsStored: 0,
          retriesCreated: 0,
          quarantinesCreated: 0,
        };

        if (capturedHead === null) {
          await store.completeSyncRun({
            runId,
            watchTargetId: target.id,
            startingHeadSignature: target.committedHeadSignature,
            capturedHead: null,
            completedAt: input.now,
            result: "complete",
            coverage: target.coverage,
            advanceCursor: false,
            counts,
          });
          return {
            runId,
            capturedHeadSignature: null,
            capturedHeadSlot: null,
            ...counts,
            cursorAdvanced: false,
            result: "complete",
          };
        }

        const discovered = new Map<string, DiscoveredWithOrder>();
        discovered.set(capturedHead.signature, {
          value: capturedHead,
          order: 0,
        });
        let discoveryOrder = 1;
        let before = capturedHead.signature;
        let paginationBlocked = false;
        let paginationErrorCode: IngestionErrorCode | undefined;
        const floor = overlapFloor(target);

        try {
          let pageNumber = 0;
          while (true) {
            const page = await rpc.getSignaturesForAddress({
              address: target.address,
              commitment: "confirmed",
              limit: pageLimit,
              before,
            });
            if (page.length === 0) {
              break;
            }
            if (page.some((entry) => entry.signature === before)) {
              throw new IngestionError(
                "rpc_page_no_progress",
                "Address-history page repeated its request boundary",
                { retryable: true },
              );
            }
            for (let index = 1; index < page.length; index += 1) {
              const previous = page[index - 1];
              const current = page[index];
              if (
                previous !== undefined &&
                current !== undefined &&
                current.slot > previous.slot
              ) {
                throw new IngestionError(
                  "rpc_page_order_invalid",
                  "Address-history page is not newest first",
                  { retryable: true },
                );
              }
            }
            try {
              await store.recordPage({
                runId,
                pageNumber,
                before,
                signatures: page,
                digest: pageDigest(page),
              });
            } catch (error) {
              throw asStorageError(error);
            }
            counts.pagesRead += 1;
            pageNumber += 1;

            for (const entry of page) {
              if (entry.slot < floor) {
                continue;
              }
              const existing = discovered.get(entry.signature);
              if (
                existing !== undefined &&
                existing.value.slot !== entry.slot
              ) {
                throw new IngestionError(
                  "rpc_signature_conflict",
                  "One signature appeared with conflicting slots",
                  { retryable: false },
                );
              }
              if (existing === undefined) {
                discovered.set(entry.signature, {
                  value: entry,
                  order: discoveryOrder,
                });
                discoveryOrder += 1;
              }
            }
            const oldest = page.at(-1);
            if (oldest === undefined || oldest.slot < floor) {
              break;
            }
            before = oldest.signature;
          }
        } catch (error) {
          const ingestionError = asIngestionError(error);
          paginationBlocked = true;
          paginationErrorCode = ingestionError.code;
          const retryRecorded = await store.recordRetry({
            runId,
            providerId: provider.id,
            watchTargetId: target.id,
            signature: null,
            operation: isStorageError(ingestionError) ? "storage" : "page",
            code: ingestionError.code,
            message: safeMessage(ingestionError.code),
            now: input.now,
          });
          counts.retriesCreated += Number(retryRecorded);
        }

        if (!paginationBlocked) {
          for (const operation of ["page", "storage"] as const) {
            await store.resolveRetry({
              providerId: provider.id,
              watchTargetId: target.id,
              signature: null,
              operation,
              resolvedAt: input.now,
            });
          }
        }

        const ordered = [...discovered.values()].sort((left, right) => {
          if (left.value.slot < right.value.slot) return -1;
          if (left.value.slot > right.value.slot) return 1;
          return left.order - right.order;
        });
        counts.signaturesDiscovered = ordered.length;
        let transactionBlocked = false;
        let hasQuarantine = false;

        if (!paginationBlocked) {
          for (const { value: entry } of ordered) {
            let discoveryResult;
            try {
              discoveryResult = await store.recordRepresentation({
                runId,
                providerId: provider.id,
                watchTargetId: target.id,
                discovered: entry,
                classification: "pending",
                snapshot: null,
                transaction: null,
                transfers: [],
                parserVersion,
                observedAt: input.now,
              });
            } catch (error) {
              const storageError = asStorageError(error);
              transactionBlocked = true;
              const retryRecorded = await store.recordRetry({
                runId,
                providerId: provider.id,
                watchTargetId: target.id,
                signature: entry.signature,
                operation: "storage",
                code: storageError.code,
                message: safeMessage(storageError.code),
                now: input.now,
              });
              counts.retriesCreated += Number(retryRecorded);
              continue;
            }
            counts.signaturesStored += Number(
              discoveryResult.signatureInserted,
            );
            let transaction;
            try {
              transaction = await rpc.getTransaction(
                entry.signature,
                "confirmed",
              );
              if (transaction === null) {
                throw new IngestionError(
                  "rpc_transaction_missing",
                  "Confirmed transaction is temporarily unavailable",
                  { retryable: true },
                );
              }
            } catch (error) {
              const ingestionError = asIngestionError(error);
              if (ingestionError.retryable) {
                transactionBlocked = true;
                const retryRecorded = await store.recordRetry({
                  runId,
                  providerId: provider.id,
                  watchTargetId: target.id,
                  signature: entry.signature,
                  operation: "transaction",
                  code: ingestionError.code,
                  message: safeMessage(ingestionError.code),
                  now: input.now,
                });
                counts.retriesCreated += Number(retryRecorded);
                continue;
              }
              let result;
              try {
                result = await store.recordRepresentation({
                  runId,
                  providerId: provider.id,
                  watchTargetId: target.id,
                  discovered: entry,
                  classification: "quarantined",
                  snapshot: null,
                  transaction: null,
                  transfers: [],
                  parserVersion,
                  observedAt: input.now,
                  quarantineCode: ingestionError.code,
                  quarantineMessage: safeMessage(ingestionError.code),
                });
              } catch (error) {
                const storageError = asStorageError(error);
                transactionBlocked = true;
                const retryRecorded = await store.recordRetry({
                  runId,
                  providerId: provider.id,
                  watchTargetId: target.id,
                  signature: entry.signature,
                  operation: "storage",
                  code: storageError.code,
                  message: safeMessage(storageError.code),
                  now: input.now,
                });
                counts.retriesCreated += Number(retryRecorded);
                continue;
              }
              counts.signaturesStored += Number(result.signatureInserted);
              counts.quarantinesCreated += Number(result.quarantineInserted);
              hasQuarantine = true;
              continue;
            }

            const snapshot = createCanonicalSnapshot(transaction);
            let classification:
              "parsed" | "irrelevant" | "failed_transaction" | "quarantined";
            let transfers = [] as ReturnType<typeof parseTransactionTransfers>;
            let quarantineCode: IngestionErrorCode | undefined;
            let quarantineMessage: string | undefined;
            if (transaction.meta.err !== null || entry.err !== null) {
              classification = "failed_transaction";
            } else {
              try {
                transfers = parseTransactionTransfers(transaction, {
                  watchedAddress: target.address,
                });
                classification = transfers.length > 0 ? "parsed" : "irrelevant";
              } catch (error) {
                classification = "quarantined";
                quarantineCode = "rpc_transaction_schema_invalid";
                quarantineMessage =
                  error instanceof UnsupportedTransferEvidenceError
                    ? error.message
                    : safeMessage(quarantineCode);
                hasQuarantine = true;
              }
            }
            let result;
            try {
              result = await store.recordRepresentation({
                runId,
                providerId: provider.id,
                watchTargetId: target.id,
                discovered: entry,
                classification,
                snapshot,
                transaction,
                transfers,
                parserVersion,
                observedAt: input.now,
                ...(quarantineCode === undefined ? {} : { quarantineCode }),
                ...(quarantineMessage === undefined
                  ? {}
                  : { quarantineMessage }),
              });
            } catch (error) {
              const storageError = asStorageError(error);
              transactionBlocked = true;
              const retryRecorded = await store.recordRetry({
                runId,
                providerId: provider.id,
                watchTargetId: target.id,
                signature: entry.signature,
                operation: "storage",
                code: storageError.code,
                message: safeMessage(storageError.code),
                now: input.now,
              });
              counts.retriesCreated += Number(retryRecorded);
              continue;
            }
            counts.signaturesStored += Number(result.signatureInserted);
            counts.eventsStored += result.eventsInserted;
            counts.quarantinesCreated += Number(result.quarantineInserted);
          }
        }

        const canAdvance = !paginationBlocked && !transactionBlocked;
        const result =
          paginationBlocked || transactionBlocked || hasQuarantine
            ? "incomplete"
            : "complete";
        const cursorAdvanced = await store.completeSyncRun({
          runId,
          watchTargetId: target.id,
          startingHeadSignature: target.committedHeadSignature,
          capturedHead,
          completedAt: input.now,
          result,
          coverage: hasQuarantine ? "incomplete" : target.coverage,
          advanceCursor: canAdvance,
          counts,
          ...(paginationErrorCode === undefined
            ? {}
            : { errorCode: paginationErrorCode }),
        });

        return {
          runId,
          capturedHeadSignature: capturedHead.signature,
          capturedHeadSlot: capturedHead.slot.toString(),
          ...counts,
          cursorAdvanced,
          result: cursorAdvanced || !canAdvance ? result : "incomplete",
        };
      } finally {
        await lock.release();
      }
    },
  };
}
