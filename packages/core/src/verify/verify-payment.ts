import type {
  ParsedTransfer,
  VerificationCheck,
  VerificationCode,
  VerificationReport,
} from "../domain/types.js";
import { SUPPORTED_MAINNET_ASSETS } from "../domain/constants.js";
import type { PaymentFixture } from "../fixtures/schema.js";

function makeCheck(
  code: VerificationCode,
  passed: boolean,
  expected: string,
  actual: string,
): VerificationCheck {
  return { code, passed, expected, actual };
}

function commitmentRank(commitment: "confirmed" | "finalized"): number {
  return commitment === "finalized" ? 2 : 1;
}

function tokenBalance(
  balances: PaymentFixture["rpcTransaction"]["meta"]["postTokenBalances"],
  accountIndex: number,
) {
  return balances.find((balance) => balance.accountIndex === accountIndex);
}

function aggregateDestinationDelta(
  transfers: readonly ParsedTransfer[],
  destinationAccountIndex: number,
  mint: string,
): bigint {
  return transfers.reduce((net, transfer) => {
    if (transfer.mint !== mint) {
      return net;
    }
    const credit =
      transfer.destinationAccountIndex === destinationAccountIndex
        ? BigInt(transfer.amountBaseUnits)
        : 0n;
    const debit =
      transfer.sourceAccountIndex === destinationAccountIndex
        ? BigInt(transfer.amountBaseUnits)
        : 0n;
    return net + credit - debit;
  }, 0n);
}

export function verifyPayment(
  fixture: PaymentFixture,
  transfer: ParsedTransfer,
  allTransfers: readonly ParsedTransfer[],
): VerificationReport {
  const { expectation, rpcTransaction } = fixture;
  const preBalance = tokenBalance(
    rpcTransaction.meta.preTokenBalances,
    transfer.destinationAccountIndex,
  );
  const postBalance = tokenBalance(
    rpcTransaction.meta.postTokenBalances,
    transfer.destinationAccountIndex,
  );
  const actualBalanceDelta =
    BigInt(postBalance?.uiTokenAmount.amount ?? "0") -
    BigInt(preBalance?.uiTokenAmount.amount ?? "0");
  const parsedBalanceDelta = aggregateDestinationDelta(
    allTransfers,
    transfer.destinationAccountIndex,
    transfer.mint,
  );
  const supportedAsset = Object.values(SUPPORTED_MAINNET_ASSETS).find(
    (asset) => String(asset.mint) === expectation.mint,
  );

  const checks: readonly VerificationCheck[] = [
    makeCheck(
      "transaction_success",
      rpcTransaction.meta.err === null,
      "null",
      JSON.stringify(rpcTransaction.meta.err) ?? "unserializable",
    ),
    makeCheck(
      "cluster",
      rpcTransaction.cluster === expectation.cluster,
      expectation.cluster,
      rpcTransaction.cluster,
    ),
    makeCheck(
      "commitment",
      commitmentRank(rpcTransaction.commitment) >=
        commitmentRank(expectation.requiredCommitment),
      expectation.requiredCommitment,
      rpcTransaction.commitment,
    ),
    makeCheck(
      "token_program",
      transfer.programId === expectation.tokenProgram &&
        supportedAsset !== undefined &&
        String(supportedAsset.tokenProgram) === expectation.tokenProgram,
      expectation.tokenProgram,
      transfer.programId,
    ),
    makeCheck(
      "mint",
      transfer.mint === expectation.mint && supportedAsset !== undefined,
      expectation.mint,
      transfer.mint,
    ),
    makeCheck(
      "destination",
      transfer.destinationTokenAccount === expectation.destinationTokenAccount,
      expectation.destinationTokenAccount,
      transfer.destinationTokenAccount,
    ),
    makeCheck(
      "destination_owner",
      postBalance?.owner === expectation.recipientOwner,
      expectation.recipientOwner,
      postBalance?.owner ?? "missing",
    ),
    makeCheck(
      "destination_token_program",
      postBalance?.programId === expectation.tokenProgram,
      expectation.tokenProgram,
      postBalance?.programId ?? "missing",
    ),
    makeCheck(
      "destination_balance_mint",
      postBalance?.mint === expectation.mint,
      expectation.mint,
      postBalance?.mint ?? "missing",
    ),
    makeCheck(
      "amount",
      transfer.amountBaseUnits === expectation.amountBaseUnits,
      expectation.amountBaseUnits,
      transfer.amountBaseUnits,
    ),
    makeCheck(
      "decimals",
      transfer.decimals === expectation.decimals &&
        supportedAsset?.decimals === expectation.decimals,
      String(expectation.decimals),
      String(transfer.decimals),
    ),
    makeCheck(
      "reference",
      transfer.references.includes(expectation.reference),
      expectation.reference,
      transfer.references.join(","),
    ),
    makeCheck(
      "unambiguous_reference_accounts",
      transfer.unsupportedExtraAccounts.length === 0,
      "none",
      transfer.unsupportedExtraAccounts.join(",") || "none",
    ),
    makeCheck(
      "non_self_transfer",
      transfer.sourceAccountIndex !== transfer.destinationAccountIndex,
      "different source and destination",
      transfer.sourceAccountIndex === transfer.destinationAccountIndex
        ? "same source and destination"
        : "different source and destination",
    ),
    makeCheck(
      "destination_balance_delta",
      actualBalanceDelta === parsedBalanceDelta,
      parsedBalanceDelta.toString(),
      actualBalanceDelta.toString(),
    ),
  ];

  return {
    schemaVersion: "0.1",
    fixtureName: fixture.name,
    eventId: transfer.eventId,
    signature: transfer.signature,
    slot: transfer.slot,
    verified: checks.every((check) => check.passed),
    checks,
    transfer,
  };
}
