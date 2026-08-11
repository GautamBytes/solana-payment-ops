import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "../audit/audit-store.js";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import type { IdempotencyResponseCommitter } from "../idempotency/idempotency-store.js";
import {
  ASSET_SYMBOLS,
  assetBySymbol,
  type AssetSymbol,
} from "./asset-registry.js";
import type { SolanaAccountRpcPort } from "./rpc-port.js";
import {
  associatedTokenAddress,
  canonicalSolanaAddress,
  createWalletProofMessage,
  verifyWalletProof,
  WalletProofError,
} from "./wallet-proof.js";

const challengeLifetimeMs = 10 * 60 * 1_000;
const replacementDelayMs = 24 * 60 * 60 * 1_000;
const providerIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface WalletChallenge {
  readonly id: string;
  readonly address: string;
  readonly nonce: string;
  readonly message: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface MerchantWalletAsset {
  readonly symbol: AssetSymbol;
  readonly mint: string;
  readonly tokenAccount: string;
  readonly decimals: 6;
}

export interface MerchantWallet {
  readonly id: string;
  readonly address: string;
  readonly cluster: "mainnet-beta";
  readonly status: "active" | "replaced";
  readonly verifiedAt: string;
  readonly assets: readonly MerchantWalletAsset[];
}

export interface WalletProofSubmission {
  readonly challengeId: string;
  readonly nonce: string;
  readonly signature: string;
}

export class WalletStoreError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(
      "Merchant wallet operation failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "WalletStoreError";
    this.code = code;
  }
}

export class WalletStore {
  readonly #database: OrganizationDatabase;
  readonly #proofDomain: string;
  readonly #providerId: string;
  readonly #rpc: SolanaAccountRpcPort;

  public constructor(options: {
    readonly database: OrganizationDatabase;
    readonly proofDomain: string;
    readonly providerId: string;
    readonly rpc: SolanaAccountRpcPort;
  }) {
    if (!providerIdPattern.test(options.providerId)) {
      throw new WalletStoreError("invalid_wallet_configuration");
    }
    this.#database = options.database;
    this.#proofDomain = options.proofDomain;
    this.#providerId = options.providerId;
    this.#rpc = options.rpc;
  }

  public async createChallenge(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly address: string;
    readonly now: Date;
  }): Promise<WalletChallenge> {
    const canonicalAddress = canonicalSolanaAddress(input.address);
    assertDate(input.now);
    const nonce = randomBytes(32).toString("base64url");
    const issuedAt = new Date(input.now);
    const expiresAt = new Date(input.now.getTime() + challengeLifetimeMs);
    const id = randomUUID();
    const message = createWalletProofMessage({
      domain: this.#proofDomain,
      organizationId: input.organizationId,
      address: canonicalAddress,
      nonce,
      issuedAt,
      expiresAt,
    });
    await this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) => {
        await transaction`
          INSERT INTO wallet_proof_challenges (
            id, organization_id, address, nonce_digest, issued_at,
            expires_at, created_at
          ) VALUES (
            ${id}::uuid, ${input.organizationId}::uuid, ${canonicalAddress},
            ${digestNonce(nonce)}, ${issuedAt.toISOString()},
            ${expiresAt.toISOString()}, ${issuedAt.toISOString()}
          )
        `;
      },
    );
    return {
      id,
      address: canonicalAddress,
      nonce,
      message,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  public async register(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly proof: WalletProofSubmission;
    readonly acceptedAssetSymbols: readonly string[];
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: IdempotencyResponseCommitter;
  }): Promise<MerchantWallet> {
    const assets = normalizeAssets(input.acceptedAssetSymbols);
    assertDate(input.now);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (transaction) => {
          const address = await this.#consumeProof(
            transaction,
            input.organizationId,
            input.proof,
            input.now,
          );
          const accounts = await verifyAssetAccounts(
            this.#rpc,
            address,
            assets,
          );
          const head = await this.#rpc.getFinalizedHead();
          if (head.slot < 0n)
            throw new WalletStoreError("solana_rpc_unavailable");
          const walletId = randomUUID();
          await insertWallet(
            transaction,
            {
              organizationId: input.organizationId,
              walletId,
              address,
              now: input.now,
            },
            accounts,
          );
          await insertWatchTargets(transaction, {
            organizationId: input.organizationId,
            walletId,
            providerId: this.#providerId,
            accounts,
            slot: head.slot,
            signature: head.signature,
            now: input.now,
          });
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(transaction, {
              organizationId: input.organizationId,
              actorKind: "session",
              actorId: input.actorId,
              action: "wallet.register",
              objectKind: "merchant_wallet",
              objectId: walletId,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: "registered",
              occurredAt: input.now,
            });
          }
          const wallet = toWallet(walletId, address, input.now, accounts);
          await input.idempotency?.complete(transaction, 201, wallet);
          return wallet;
        },
      );
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  public async list(input: {
    readonly organizationId: string;
    readonly actorId: string;
  }): Promise<readonly MerchantWallet[]> {
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) => {
        const rows = await transaction<
          {
            id: string;
            address: string;
            status: "active" | "replaced";
            verified_at: Date;
            symbol: AssetSymbol | null;
            mint: string | null;
            token_account: string | null;
            decimals: number | null;
          }[]
        >`
          SELECT wallet.id::text, wallet.address, wallet.status,
            wallet.verified_at, asset.symbol, asset.mint,
            asset.token_account, asset.decimals
          FROM merchant_wallets AS wallet
          LEFT JOIN merchant_wallet_assets AS asset
            ON asset.organization_id = wallet.organization_id
            AND asset.wallet_id = wallet.id
          WHERE wallet.organization_id = ${input.organizationId}::uuid
          ORDER BY wallet.created_at DESC, wallet.id DESC, asset.symbol
        `;
        const grouped = new Map<string, MerchantWallet>();
        for (const row of rows) {
          const current = grouped.get(row.id) ?? {
            id: row.id,
            address: row.address,
            cluster: "mainnet-beta" as const,
            status: row.status,
            verifiedAt: row.verified_at.toISOString(),
            assets: [],
          };
          if (
            row.symbol !== null &&
            row.mint !== null &&
            row.token_account !== null &&
            row.decimals === 6
          ) {
            (current.assets as MerchantWalletAsset[]).push({
              symbol: row.symbol,
              mint: row.mint,
              tokenAccount: row.token_account,
              decimals: 6,
            });
          }
          grouped.set(row.id, current);
        }
        return [...grouped.values()];
      },
    );
  }

  public async requestReplacement(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly walletId: string;
    readonly proof: WalletProofSubmission;
    readonly acceptedAssetSymbols: readonly string[];
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: IdempotencyResponseCommitter;
  }): Promise<{
    readonly replacementId: string;
    readonly activatesAt: string;
  }> {
    const assets = normalizeAssets(input.acceptedAssetSymbols);
    assertDate(input.now);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (transaction) => {
          await requireActiveWallet(
            transaction,
            input.organizationId,
            input.walletId,
          );
          const address = await this.#consumeProof(
            transaction,
            input.organizationId,
            input.proof,
            input.now,
          );
          await verifyAssetAccounts(this.#rpc, address, assets);
          const replacementId = randomUUID();
          const activatesAt = new Date(
            input.now.getTime() + replacementDelayMs,
          );
          await transaction`
            INSERT INTO wallet_replacement_requests (
              id, organization_id, wallet_id, replacement_address,
              accepted_asset_symbols, requested_by, requested_at, activates_at,
              created_at
            ) VALUES (
              ${replacementId}::uuid, ${input.organizationId}::uuid,
              ${input.walletId}::uuid, ${address}, ${assets.map((asset) => asset.symbol)},
              ${input.actorId}, ${input.now.toISOString()},
              ${activatesAt.toISOString()}, ${input.now.toISOString()}
            )
          `;
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(transaction, {
              organizationId: input.organizationId,
              actorKind: "session",
              actorId: input.actorId,
              action: "wallet.replacement_request",
              objectKind: "wallet_replacement",
              objectId: replacementId,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: "cooling_started",
              occurredAt: input.now,
            });
          }
          const result = {
            replacementId,
            activatesAt: activatesAt.toISOString(),
          };
          await input.idempotency?.complete(transaction, 202, result);
          return result;
        },
      );
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  public async activateReplacement(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly walletId: string;
    readonly proof: WalletProofSubmission;
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: IdempotencyResponseCommitter;
  }): Promise<MerchantWallet> {
    assertDate(input.now);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (transaction) => {
          const pendingRows = await transaction<
            {
              id: string;
              replacement_address: string;
              accepted_asset_symbols: string[];
              activates_at: Date;
            }[]
          >`
            SELECT id::text, replacement_address, accepted_asset_symbols,
              activates_at
            FROM wallet_replacement_requests
            WHERE organization_id = ${input.organizationId}::uuid
              AND wallet_id = ${input.walletId}::uuid
              AND activated_at IS NULL
            FOR UPDATE
          `;
          const pending = pendingRows[0];
          if (pending === undefined)
            throw new WalletStoreError("wallet_replacement_not_found");
          if (pending.activates_at.getTime() > input.now.getTime()) {
            throw new WalletStoreError("wallet_replacement_cooling");
          }
          const proofAddress = await this.#consumeProof(
            transaction,
            input.organizationId,
            input.proof,
            input.now,
          );
          if (proofAddress !== pending.replacement_address) {
            throw new WalletStoreError("invalid_wallet_proof");
          }
          const assets = normalizeAssets(pending.accepted_asset_symbols);
          const accounts = await verifyAssetAccounts(
            this.#rpc,
            proofAddress,
            assets,
          );
          const head = await this.#rpc.getFinalizedHead();
          await requireActiveWallet(
            transaction,
            input.organizationId,
            input.walletId,
          );
          await transaction`
            UPDATE merchant_wallets SET status = 'replaced',
              replaced_at = ${input.now.toISOString()},
              updated_at = ${input.now.toISOString()}
            WHERE organization_id = ${input.organizationId}::uuid
              AND id = ${input.walletId}::uuid AND status = 'active'
          `;
          await transaction`
            UPDATE watch_targets SET active = false
            WHERE organization_id = ${input.organizationId}::uuid
              AND id LIKE ${`merchant-wallet:${input.walletId}:%`}
          `;
          const walletId = randomUUID();
          await insertWallet(
            transaction,
            {
              organizationId: input.organizationId,
              walletId,
              address: proofAddress,
              now: input.now,
            },
            accounts,
          );
          await insertWatchTargets(transaction, {
            organizationId: input.organizationId,
            walletId,
            providerId: this.#providerId,
            accounts,
            slot: head.slot,
            signature: head.signature,
            now: input.now,
          });
          await transaction`
            UPDATE wallet_replacement_requests
            SET activated_at = ${input.now.toISOString()}
            WHERE id = ${pending.id}::uuid AND activated_at IS NULL
          `;
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(transaction, {
              organizationId: input.organizationId,
              actorKind: "session",
              actorId: input.actorId,
              action: "wallet.replacement_activate",
              objectKind: "merchant_wallet",
              objectId: walletId,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: "activated",
              occurredAt: input.now,
            });
          }
          const wallet = toWallet(walletId, proofAddress, input.now, accounts);
          await input.idempotency?.complete(transaction, 200, wallet);
          return wallet;
        },
      );
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  async #consumeProof(
    transaction: OrganizationTransaction,
    organizationId: string,
    proof: WalletProofSubmission,
    now: Date,
  ): Promise<string> {
    const rows = await transaction<
      {
        id: string;
        address: string;
        nonce_digest: string;
        issued_at: Date;
        expires_at: Date;
        consumed_at: Date | null;
      }[]
    >`
      SELECT id::text, address, nonce_digest, issued_at, expires_at, consumed_at
      FROM wallet_proof_challenges
      WHERE id = ${proof.challengeId}::uuid
        AND organization_id = ${organizationId}::uuid
      FOR UPDATE
    `;
    const challenge = rows[0];
    if (
      challenge === undefined ||
      challenge.consumed_at !== null ||
      challenge.expires_at.getTime() <= now.getTime() ||
      !nonceMatches(challenge.nonce_digest, proof.nonce)
    ) {
      throw new WalletStoreError("invalid_wallet_proof");
    }
    await verifyWalletProof({
      fields: {
        domain: this.#proofDomain,
        organizationId,
        address: challenge.address,
        nonce: proof.nonce,
        issuedAt: challenge.issued_at,
        expiresAt: challenge.expires_at,
      },
      signature: proof.signature,
      now,
    });
    const consumed = await transaction<{ id: string }[]>`
      UPDATE wallet_proof_challenges SET consumed_at = ${now.toISOString()}
      WHERE id = ${challenge.id}::uuid AND consumed_at IS NULL
      RETURNING id::text
    `;
    if (consumed.length !== 1)
      throw new WalletStoreError("invalid_wallet_proof");
    return challenge.address;
  }
}

interface VerifiedAssetAccount {
  readonly symbol: AssetSymbol;
  readonly mint: string;
  readonly tokenAccount: string;
  readonly decimals: 6;
  readonly tokenProgram: string;
}

async function verifyAssetAccounts(
  rpc: SolanaAccountRpcPort,
  walletAddress: string,
  assets: readonly ReturnType<typeof assetBySymbol>[],
): Promise<readonly VerifiedAssetAccount[]> {
  try {
    return await Promise.all(
      assets.map(async (asset) => {
        const tokenAccount = await associatedTokenAddress(walletAddress, asset);
        const state = await rpc.getTokenAccount(tokenAccount);
        if (
          state === null ||
          state.address !== tokenAccount ||
          state.owner !== walletAddress ||
          state.mint !== asset.mint ||
          state.programOwner !== asset.tokenProgram
        ) {
          throw new WalletStoreError("invalid_settlement_token_account");
        }
        return {
          symbol: asset.symbol,
          mint: asset.mint,
          tokenAccount,
          decimals: asset.decimals,
          tokenProgram: asset.tokenProgram,
        };
      }),
    );
  } catch (error) {
    const code = safeOwnCode(error);
    if (
      code === "invalid_settlement_token_account" ||
      code === "invalid_wallet_address"
    ) {
      throw new WalletStoreError(code);
    }
    throw new WalletStoreError("solana_rpc_unavailable", error);
  }
}

async function insertWallet(
  transaction: OrganizationTransaction,
  input: {
    readonly organizationId: string;
    readonly walletId: string;
    readonly address: string;
    readonly now: Date;
  },
  accounts: readonly VerifiedAssetAccount[],
): Promise<void> {
  await transaction`
    INSERT INTO merchant_wallets (
      id, organization_id, address, cluster, status, verified_at,
      created_at, updated_at
    ) VALUES (
      ${input.walletId}::uuid, ${input.organizationId}::uuid, ${input.address},
      'mainnet-beta', 'active', ${input.now.toISOString()},
      ${input.now.toISOString()}, ${input.now.toISOString()}
    )
  `;
  for (const account of accounts) {
    await transaction`
      INSERT INTO merchant_wallet_assets (
        organization_id, wallet_id, symbol, mint, token_account,
        decimals, token_program, created_at
      ) VALUES (
        ${input.organizationId}::uuid, ${input.walletId}::uuid,
        ${account.symbol}, ${account.mint}, ${account.tokenAccount},
        ${account.decimals}, ${account.tokenProgram}, ${input.now.toISOString()}
      )
    `;
  }
}

async function insertWatchTargets(
  transaction: OrganizationTransaction,
  input: {
    readonly organizationId: string;
    readonly walletId: string;
    readonly providerId: string;
    readonly accounts: readonly VerifiedAssetAccount[];
    readonly slot: bigint;
    readonly signature: string | null;
    readonly now: Date;
  },
): Promise<void> {
  for (const account of input.accounts) {
    await transaction`
      INSERT INTO watch_targets (
        id, provider_id, cluster, address, cutover_slot, cutover_signature,
        overlap_slots, committed_head_slot, committed_head_signature,
        coverage, active, created_at, organization_id
      ) VALUES (
        ${`merchant-wallet:${input.walletId}:${account.symbol}`},
        ${input.providerId}, 'mainnet-beta', ${account.tokenAccount},
        ${input.slot.toString()}, ${input.signature}, 64,
        ${input.slot.toString()}, ${input.signature}, 'complete', true,
        ${input.now.toISOString()}, ${input.organizationId}::uuid
      )
    `;
  }
}

async function requireActiveWallet(
  transaction: OrganizationTransaction,
  organizationId: string,
  walletId: string,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id::text FROM merchant_wallets
    WHERE organization_id = ${organizationId}::uuid
      AND id = ${walletId}::uuid AND status = 'active'
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new WalletStoreError("wallet_not_found");
}

function normalizeAssets(
  symbols: readonly string[],
): readonly ReturnType<typeof assetBySymbol>[] {
  if (symbols.length < 1 || symbols.length > ASSET_SYMBOLS.length) {
    throw new WalletStoreError("invalid_accepted_assets");
  }
  const unique = [...new Set(symbols)].sort();
  if (unique.length !== symbols.length)
    throw new WalletStoreError("invalid_accepted_assets");
  return unique.map(assetBySymbol);
}

function toWallet(
  id: string,
  address: string,
  now: Date,
  accounts: readonly VerifiedAssetAccount[],
): MerchantWallet {
  return {
    id,
    address,
    cluster: "mainnet-beta",
    status: "active",
    verifiedAt: now.toISOString(),
    assets: accounts.map(({ symbol, mint, tokenAccount, decimals }) => ({
      symbol,
      mint,
      tokenAccount,
      decimals,
    })),
  };
}

function digestNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function nonceMatches(expectedDigest: string, nonce: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return false;
  const actual = Buffer.from(digestNonce(nonce), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertDate(value: Date): void {
  if (!Number.isFinite(value.getTime()))
    throw new WalletStoreError("invalid_wallet_time");
}

function mapWalletError(error: unknown): WalletStoreError | WalletProofError {
  const code = safeOwnCode(error);
  if (
    code !== undefined &&
    [
      "invalid_wallet_proof",
      "invalid_wallet_address",
      "invalid_settlement_token_account",
      "solana_rpc_unavailable",
      "wallet_replacement_not_found",
      "wallet_replacement_cooling",
      "wallet_not_found",
      "invalid_accepted_assets",
      "invalid_wallet_time",
    ].includes(code)
  ) {
    return new WalletStoreError(code);
  }
  if (code === "23505")
    return new WalletStoreError("wallet_already_registered");
  if (code === "23503")
    return new WalletStoreError("wallet_configuration_unavailable");
  return new WalletStoreError("wallet_store_unavailable", error);
}

function safeOwnCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
