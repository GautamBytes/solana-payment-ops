import {
  MAINNET_USDC,
  MAINNET_USDT,
  parseTransactionTransfers,
  type ParsedTransfer,
} from "@payops/core";
import { address } from "@solana/kit";

import type { AddressSignature, SolanaRpcPort } from "../domain/types.js";

export type PublicAssetSymbol = "USDC" | "USDT";
export type ExpectationStatus =
  "not_provided" | "partial" | "matched" | "not_matched";

export interface PublicWalletExpectation {
  readonly assetSymbol?: PublicAssetSymbol;
  readonly amountBaseUnits?: string;
  readonly destinationTokenAccount?: string;
  readonly reference?: string;
}

export interface PublicWalletAnalysisInput {
  readonly walletAddress: string;
  readonly watchedTokenAccounts: readonly {
    readonly assetSymbol: PublicAssetSymbol;
    readonly address: string;
  }[];
  readonly fromTime: Date;
  readonly throughTime: Date;
  readonly expectation?: PublicWalletExpectation;
}

export interface PublicWalletExpectationCheck {
  readonly field: "asset" | "amount" | "recipient" | "reference";
  readonly passed: boolean;
}

export interface PublicWalletTransfer {
  readonly signature: string;
  readonly slot: string;
  readonly blockTime: string;
  readonly assetSymbol: PublicAssetSymbol;
  readonly mint: string;
  readonly amountBaseUnits: string;
  readonly amountTokens: string;
  readonly sourceTokenAccount: string;
  readonly destinationTokenAccount: string;
  readonly references: readonly string[];
  readonly expectationStatus: ExpectationStatus;
  readonly expectationChecks: readonly PublicWalletExpectationCheck[];
}

export interface PublicWalletAnalysis {
  readonly schemaVersion: "0.1";
  readonly walletAddress: string;
  readonly fromTime: string;
  readonly throughTime: string;
  readonly coverage: "complete" | "partial";
  readonly transfers: readonly PublicWalletTransfer[];
}

export type PublicWalletAnalysisErrorCode =
  "invalid_analysis_input" | "analysis_unavailable" | "analysis_too_large";

export class PublicWalletAnalysisError extends Error {
  public readonly code: PublicWalletAnalysisErrorCode;

  public constructor(
    code: PublicWalletAnalysisErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "PublicWalletAnalysisError";
    this.code = code;
  }
}

interface AnalysisDependencies {
  readonly rpc: SolanaRpcPort;
  readonly maxSignatures: number;
  readonly maxTransactions: number;
  readonly concurrency: number;
}

interface Candidate {
  readonly signature: AddressSignature;
  readonly watchedAddresses: Set<string>;
}

const assets = {
  USDC: MAINNET_USDC,
  USDT: MAINNET_USDT,
} as const;
const maximumRangeMs = 30 * 24 * 60 * 60 * 1_000;

function invalid(message: string): never {
  throw new PublicWalletAnalysisError("invalid_analysis_input", message);
}

function validateAddress(value: string, field: string): void {
  try {
    address(value);
  } catch {
    invalid(`${field} must be a valid Solana address`);
  }
}

function validateInput(
  input: PublicWalletAnalysisInput,
  dependencies: AnalysisDependencies,
): void {
  validateAddress(input.walletAddress, "walletAddress");
  if (
    input.watchedTokenAccounts.length < 1 ||
    input.watchedTokenAccounts.length > 2
  ) {
    invalid("watchedTokenAccounts must contain one or two accounts");
  }
  for (const tokenAccount of input.watchedTokenAccounts) {
    validateAddress(tokenAccount.address, "watched token account");
  }

  const from = input.fromTime.getTime();
  const through = input.throughTime.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(through) || through <= from) {
    invalid("analysis time range is invalid");
  }
  if (through - from > maximumRangeMs) {
    throw new PublicWalletAnalysisError(
      "analysis_too_large",
      "analysis time range cannot exceed 30 days",
    );
  }

  const limits = [
    [dependencies.maxSignatures, 200, "maxSignatures"],
    [dependencies.maxTransactions, 100, "maxTransactions"],
    [dependencies.concurrency, 4, "concurrency"],
  ] as const;
  for (const [value, maximum, name] of limits) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      invalid(`${name} must be an integer from 1 to ${maximum}`);
    }
  }

  const expectation = input.expectation;
  if (expectation?.amountBaseUnits !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(expectation.amountBaseUnits)) {
      invalid("expected amount must use non-negative base units");
    }
  }
  if (expectation?.destinationTokenAccount !== undefined) {
    validateAddress(
      expectation.destinationTokenAccount,
      "expected destination token account",
    );
  }
  if (expectation?.reference !== undefined) {
    validateAddress(expectation.reference, "expected reference");
  }
}

async function discoverCandidates(
  input: PublicWalletAnalysisInput,
  dependencies: AnalysisDependencies,
): Promise<{ readonly candidates: readonly Candidate[]; partial: boolean }> {
  const bySignature = new Map<string, Candidate>();
  let partial = false;
  let inspectedSignatures = 0;
  const fromSeconds = BigInt(Math.floor(input.fromTime.getTime() / 1_000));
  const throughSeconds = BigInt(
    Math.floor(input.throughTime.getTime() / 1_000),
  );

  for (const tokenAccount of input.watchedTokenAccounts) {
    let before: string | undefined;
    let reachedRangeBoundary = false;

    while (!reachedRangeBoundary) {
      const remaining = dependencies.maxSignatures - inspectedSignatures;
      if (remaining === 0) {
        partial = true;
        break;
      }
      const limit = Math.min(100, remaining);
      const page = await dependencies.rpc.getSignaturesForAddress({
        address: tokenAccount.address,
        commitment: "confirmed",
        limit,
        ...(before === undefined ? {} : { before }),
      });
      if (page.length === 0) break;
      if (page.length > limit) partial = true;
      const inspectedPage = page.slice(0, limit);
      inspectedSignatures += inspectedPage.length;

      for (const entry of inspectedPage) {
        if (entry.blockTime === null) {
          partial = true;
        } else {
          if (entry.blockTime < fromSeconds) {
            reachedRangeBoundary = true;
            break;
          }
          if (entry.blockTime > throughSeconds) continue;
        }
        if (entry.err !== null || entry.confirmationStatus !== "finalized") {
          continue;
        }

        const existing = bySignature.get(entry.signature);
        if (existing === undefined) {
          bySignature.set(entry.signature, {
            signature: entry,
            watchedAddresses: new Set([tokenAccount.address]),
          });
        } else {
          existing.watchedAddresses.add(tokenAccount.address);
        }
      }

      if (reachedRangeBoundary || page.length < limit) break;
      if (inspectedSignatures >= dependencies.maxSignatures) {
        partial = true;
        break;
      }
      const last = page.at(-1);
      if (last === undefined || last.signature === before) {
        partial = true;
        break;
      }
      before = last.signature;
    }
  }

  const candidates = [...bySignature.values()];
  if (candidates.length > dependencies.maxTransactions) partial = true;
  return {
    candidates: candidates.slice(0, dependencies.maxTransactions),
    partial,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await transform(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

function formatTokenAmount(amountBaseUnits: string, decimals: number): string {
  if (decimals === 0) return amountBaseUnits;
  const padded = amountBaseUnits.padStart(decimals + 1, "0");
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

function evaluateExpectation(
  transfer: ParsedTransfer,
  assetSymbol: PublicAssetSymbol,
  expectation: PublicWalletExpectation | undefined,
): {
  readonly status: ExpectationStatus;
  readonly checks: readonly PublicWalletExpectationCheck[];
} {
  if (expectation === undefined) {
    return { status: "not_provided", checks: [] };
  }

  const checks = [
    ...(expectation.assetSymbol === undefined
      ? []
      : [
          {
            field: "asset" as const,
            passed: expectation.assetSymbol === assetSymbol,
          },
        ]),
    ...(expectation.amountBaseUnits === undefined
      ? []
      : [
          {
            field: "amount" as const,
            passed: expectation.amountBaseUnits === transfer.amountBaseUnits,
          },
        ]),
    ...(expectation.destinationTokenAccount === undefined
      ? []
      : [
          {
            field: "recipient" as const,
            passed:
              expectation.destinationTokenAccount ===
              transfer.destinationTokenAccount,
          },
        ]),
    ...(expectation.reference === undefined
      ? []
      : [
          {
            field: "reference" as const,
            passed: transfer.references.includes(expectation.reference),
          },
        ]),
  ];
  if (checks.length === 0) return { status: "not_provided", checks };
  if (checks.length < 4) return { status: "partial", checks };
  return {
    status: checks.every((check) => check.passed) ? "matched" : "not_matched",
    checks,
  };
}

function identifyAsset(
  transfer: ParsedTransfer,
): PublicAssetSymbol | undefined {
  if (transfer.mint === String(MAINNET_USDC.mint)) return "USDC";
  if (transfer.mint === String(MAINNET_USDT.mint)) return "USDT";
  return undefined;
}

export async function analyzePublicWallet(
  input: PublicWalletAnalysisInput,
  dependencies: AnalysisDependencies,
): Promise<PublicWalletAnalysis> {
  validateInput(input, dependencies);

  try {
    const discovered = await discoverCandidates(input, dependencies);
    let partial = discovered.partial;
    const transactionResults = await mapConcurrent(
      discovered.candidates,
      dependencies.concurrency,
      async (candidate) => ({
        candidate,
        transaction: await dependencies.rpc.getTransaction(
          candidate.signature.signature,
          "finalized",
        ),
      }),
    );

    const transfers = transactionResults.flatMap(
      ({ candidate, transaction }): readonly PublicWalletTransfer[] => {
        if (transaction === null) {
          partial = true;
          return [];
        }
        const transactionBlockTime = transaction.blockTime;
        const blockTime =
          transactionBlockTime === null
            ? candidate.signature.blockTime
            : BigInt(transactionBlockTime);
        if (blockTime === null) {
          partial = true;
          return [];
        }

        const seenEvents = new Set<string>();
        return [...candidate.watchedAddresses].flatMap((watchedAddress) =>
          parseTransactionTransfers(transaction, { watchedAddress }).flatMap(
            (transfer): readonly PublicWalletTransfer[] => {
              if (seenEvents.has(transfer.eventId)) return [];
              const assetSymbol = identifyAsset(transfer);
              if (assetSymbol === undefined) return [];
              const expectedAccount = input.watchedTokenAccounts.find(
                (account) =>
                  account.assetSymbol === assetSymbol &&
                  account.address === watchedAddress,
              );
              if (
                expectedAccount === undefined ||
                (transfer.sourceTokenAccount !== watchedAddress &&
                  transfer.destinationTokenAccount !== watchedAddress)
              ) {
                return [];
              }
              seenEvents.add(transfer.eventId);
              const expectation = evaluateExpectation(
                transfer,
                assetSymbol,
                input.expectation,
              );
              return [
                {
                  signature: transfer.signature,
                  slot: String(transfer.slot),
                  blockTime: new Date(Number(blockTime) * 1_000).toISOString(),
                  assetSymbol,
                  mint: transfer.mint,
                  amountBaseUnits: transfer.amountBaseUnits,
                  amountTokens: formatTokenAmount(
                    transfer.amountBaseUnits,
                    assets[assetSymbol].decimals,
                  ),
                  sourceTokenAccount: transfer.sourceTokenAccount,
                  destinationTokenAccount: transfer.destinationTokenAccount,
                  references: transfer.references,
                  expectationStatus: expectation.status,
                  expectationChecks: expectation.checks,
                },
              ];
            },
          ),
        );
      },
    );

    return {
      schemaVersion: "0.1",
      walletAddress: input.walletAddress,
      fromTime: input.fromTime.toISOString(),
      throughTime: input.throughTime.toISOString(),
      coverage: partial ? "partial" : "complete",
      transfers,
    };
  } catch (error) {
    if (error instanceof PublicWalletAnalysisError) throw error;
    throw new PublicWalletAnalysisError(
      "analysis_unavailable",
      "Public wallet analysis is temporarily unavailable",
      { cause: error },
    );
  }
}
