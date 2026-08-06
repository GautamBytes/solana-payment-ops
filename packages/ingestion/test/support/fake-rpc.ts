import type { RpcTransactionEnvelope } from "@payops/core";
import type {
  AddressSignature,
  Commitment,
  SignaturePageRequest,
  SolanaRpcPort,
  TransactionStatus,
} from "../../src/index.js";

export class FakeRpc implements SolanaRpcPort {
  public readonly signatureRequests: SignaturePageRequest[] = [];
  public readonly transactionRequests: string[] = [];
  public head: AddressSignature | null = null;
  public readonly pages = new Map<string, readonly AddressSignature[]>();
  public readonly transactions = new Map<
    string,
    RpcTransactionEnvelope | null | Error
  >();
  public statuses: readonly (TransactionStatus | null)[] = [];
  public statusError: Error | null = null;
  public currentSlot = 1_000n;

  public async getSignaturesForAddress(
    request: SignaturePageRequest,
  ): Promise<readonly AddressSignature[]> {
    this.signatureRequests.push(request);
    if (request.limit === 1 && request.before === undefined) {
      return this.head === null ? [] : [this.head];
    }
    return this.pages.get(request.before ?? "") ?? [];
  }

  public async getTransaction(
    signature: string,
    _commitment: Commitment,
  ): Promise<RpcTransactionEnvelope | null> {
    this.transactionRequests.push(signature);
    const result = this.transactions.get(signature);
    if (result instanceof Error) {
      throw result;
    }
    return result ?? null;
  }

  public async getSignatureStatuses(
    _signatures: readonly string[],
  ): Promise<readonly (TransactionStatus | null)[]> {
    if (this.statusError !== null) throw this.statusError;
    return this.statuses;
  }

  public async getSlot(_commitment: Commitment): Promise<bigint> {
    return this.currentSlot;
  }
}
