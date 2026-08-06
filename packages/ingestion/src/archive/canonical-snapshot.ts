import { createHash } from "node:crypto";
import { stringifyCanonical, type RpcTransactionEnvelope } from "@payops/core";
import type { CanonicalSnapshot } from "../domain/types.js";

function assertJsonCompatible(value: unknown, seen: Set<object>): void {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("Snapshot is not JSON-compatible");
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new TypeError("Snapshot is not JSON-compatible");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => assertJsonCompatible(entry, seen));
  } else {
    Object.values(value).forEach((entry) => assertJsonCompatible(entry, seen));
  }
  seen.delete(value);
}

export function createCanonicalSnapshot(value: unknown): CanonicalSnapshot {
  assertJsonCompatible(value, new Set<object>());
  const canonicalJson = stringifyCanonical(value);
  return {
    canonicalJson,
    byteLength: Buffer.byteLength(canonicalJson, "utf8"),
    digest: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
  };
}

export function createParsingDigest(
  transaction: RpcTransactionEnvelope,
): string {
  const parsingInstruction = (instruction: {
    readonly programIdIndex: number;
    readonly accounts: readonly number[];
    readonly data: string;
  }) => ({
    programIdIndex: instruction.programIdIndex,
    accounts: instruction.accounts,
    data: instruction.data,
  });
  const parsingBalance = (balance: {
    readonly accountIndex: number;
    readonly mint: string;
    readonly programId?: string | undefined;
    readonly uiTokenAmount: { readonly decimals: number };
  }) => ({
    accountIndex: balance.accountIndex,
    mint: balance.mint,
    programId: balance.programId ?? null,
    decimals: balance.uiTokenAmount.decimals,
  });
  const { message } = transaction.transaction;
  const tokenBalances = [
    ...transaction.meta.preTokenBalances,
    ...transaction.meta.postTokenBalances,
  ]
    .map(parsingBalance)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createCanonicalSnapshot({
    digestVersion: 1,
    cluster: transaction.cluster,
    signature: transaction.signature,
    slot: transaction.slot,
    version: transaction.version,
    message: {
      header: message.header,
      accountKeys: message.accountKeys,
      addressTableLookups: message.addressTableLookups,
      instructions: message.instructions.map(parsingInstruction),
    },
    meta: {
      err: transaction.meta.err,
      loadedAddresses: transaction.meta.loadedAddresses ?? {
        writable: [],
        readonly: [],
      },
      innerInstructions: (transaction.meta.innerInstructions ?? []).map(
        (group) => ({
          index: group.index,
          instructions: group.instructions.map(parsingInstruction),
        }),
      ),
      tokenBalances,
    },
  }).digest;
}
