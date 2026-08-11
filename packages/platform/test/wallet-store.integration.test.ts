import { randomUUID } from "node:crypto";
import {
  createSignableMessage,
  generateKeyPairSigner,
  type KeyPairSigner,
} from "@solana/kit";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  associatedTokenAddress,
  assetBySymbol,
  OrganizationDatabase,
  runPlatformMigrations,
  WalletStore,
  type SolanaAccountRpcPort,
  type TokenAccountState,
  type WalletChallenge,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_wallet_store_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";

describeDatabase("merchant wallet store", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
    const scoped = postgres(databaseUrl!, { max: 1 });
    await scoped`
      INSERT INTO rpc_providers (
        id, cluster, endpoint_env, endpoint_label, active, created_at
      ) VALUES (
        'mainnet-primary', 'mainnet-beta', 'TEST_RPC', 'Test RPC', true, now()
      )
    `;
    await scoped.end();
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("registers verified USDC and USDT ATAs once and creates watch targets", async () => {
    const signer = await generateKeyPairSigner();
    const rpc = await FakeRpc.forWallet(signer.address);
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = walletStore(database, rpc);
    const now = new Date("2026-08-12T00:00:00.000Z");
    try {
      const challenge = await store.createChallenge({
        organizationId,
        actorId: randomUUID(),
        address: signer.address,
        now,
      });
      const wallet = await store.register({
        organizationId,
        actorId: randomUUID(),
        proof: await signChallenge(signer, challenge),
        acceptedAssetSymbols: ["USDC", "USDT"],
        now: new Date(now.getTime() + 1_000),
      });
      expect(wallet).toMatchObject({
        address: signer.address,
        status: "active",
        assets: [{ symbol: "USDC" }, { symbol: "USDT" }],
      });
      await expect(
        store.register({
          organizationId,
          actorId: randomUUID(),
          proof: await signChallenge(signer, challenge),
          acceptedAssetSymbols: ["USDC", "USDT"],
          now: new Date(now.getTime() + 2_000),
        }),
      ).rejects.toMatchObject({ code: "invalid_wallet_proof" });
      await expect(
        store.list({ organizationId, actorId: randomUUID() }),
      ).resolves.toEqual([wallet]);
      const scoped = postgres(databaseUrl!, {
        max: 1,
        connection: { application_name: "wallet-test" },
      });
      try {
        await scoped`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
        await expect(
          scoped<{ count: number }[]>`
            SELECT count(*)::integer AS count FROM watch_targets
            WHERE id LIKE ${`merchant-wallet:${wallet.id}:%`} AND active
          `,
        ).resolves.toEqual([{ count: 2 }]);
      } finally {
        await scoped.end();
      }
    } finally {
      await database.close();
    }
  });

  it("rejects an invalid token account without consuming the challenge", async () => {
    const signer = await generateKeyPairSigner();
    const rpc = await FakeRpc.forWallet(signer.address);
    rpc.accounts.clear();
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = walletStore(database, rpc);
    const now = new Date("2026-08-12T00:00:00.000Z");
    try {
      const challenge = await store.createChallenge({
        organizationId,
        actorId: randomUUID(),
        address: signer.address,
        now,
      });
      const proof = await signChallenge(signer, challenge);
      await expect(
        store.register({
          organizationId,
          actorId: randomUUID(),
          proof,
          acceptedAssetSymbols: ["USDC"],
          now: new Date(now.getTime() + 1_000),
        }),
      ).rejects.toMatchObject({ code: "invalid_settlement_token_account" });
      const usdc = assetBySymbol("USDC");
      const ata = await associatedTokenAddress(signer.address, usdc);
      rpc.accounts.set(ata, {
        address: ata,
        owner: signer.address,
        mint: usdc.mint,
        programOwner: usdc.tokenProgram,
      });
      await expect(
        store.register({
          organizationId,
          actorId: randomUUID(),
          proof,
          acceptedAssetSymbols: ["USDC"],
          now: new Date(now.getTime() + 2_000),
        }),
      ).resolves.toMatchObject({ address: signer.address });
    } finally {
      await database.close();
    }
  });

  it("requires a second proof and the full cooling period for replacement", async () => {
    const currentSigner = await generateKeyPairSigner();
    const replacementSigner = await generateKeyPairSigner();
    const rpc = await FakeRpc.forWallet(
      currentSigner.address,
      replacementSigner.address,
    );
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = walletStore(database, rpc);
    const start = new Date("2026-08-12T00:00:00.000Z");
    try {
      const firstChallenge = await store.createChallenge({
        organizationId,
        actorId: randomUUID(),
        address: currentSigner.address,
        now: start,
      });
      const current = await store.register({
        organizationId,
        actorId: randomUUID(),
        proof: await signChallenge(currentSigner, firstChallenge),
        acceptedAssetSymbols: ["USDC"],
        now: new Date(start.getTime() + 1_000),
      });
      const requestChallenge = await store.createChallenge({
        organizationId,
        actorId: randomUUID(),
        address: replacementSigner.address,
        now: new Date(start.getTime() + 2_000),
      });
      const requested = await store.requestReplacement({
        organizationId,
        actorId: randomUUID(),
        walletId: current.id,
        proof: await signChallenge(replacementSigner, requestChallenge),
        acceptedAssetSymbols: ["USDC", "USDT"],
        now: new Date(start.getTime() + 3_000),
      });
      const activateChallenge = await store.createChallenge({
        organizationId,
        actorId: randomUUID(),
        address: replacementSigner.address,
        now: new Date(start.getTime() + 4_000),
      });
      const activationProof = await signChallenge(
        replacementSigner,
        activateChallenge,
      );
      await expect(
        store.activateReplacement({
          organizationId,
          actorId: randomUUID(),
          walletId: current.id,
          proof: activationProof,
          now: new Date(new Date(requested.activatesAt).getTime() - 1),
        }),
      ).rejects.toMatchObject({ code: "wallet_replacement_cooling" });
      const freshActivationChallenge = await store.createChallenge({
        organizationId,
        actorId: randomUUID(),
        address: replacementSigner.address,
        now: new Date(requested.activatesAt),
      });
      await expect(
        store.activateReplacement({
          organizationId,
          actorId: randomUUID(),
          walletId: current.id,
          proof: await signChallenge(
            replacementSigner,
            freshActivationChallenge,
          ),
          now: new Date(requested.activatesAt),
        }),
      ).resolves.toMatchObject({
        address: replacementSigner.address,
        assets: [{ symbol: "USDC" }, { symbol: "USDT" }],
      });
      const wallets = await store.list({
        organizationId,
        actorId: randomUUID(),
      });
      expect(wallets.map((wallet) => wallet.status).sort()).toEqual([
        "active",
        "replaced",
      ]);
    } finally {
      await database.close();
    }
  });
});

class FakeRpc implements SolanaAccountRpcPort {
  public readonly accounts = new Map<string, TokenAccountState>();

  public static async forWallet(...addresses: string[]): Promise<FakeRpc> {
    const rpc = new FakeRpc();
    for (const walletAddress of addresses) {
      for (const symbol of ["USDC", "USDT"] as const) {
        const asset = assetBySymbol(symbol);
        const tokenAccount = await associatedTokenAddress(walletAddress, asset);
        rpc.accounts.set(tokenAccount, {
          address: tokenAccount,
          owner: walletAddress,
          mint: asset.mint,
          programOwner: asset.tokenProgram,
        });
      }
    }
    return rpc;
  }

  public async getTokenAccount(
    address: string,
  ): Promise<TokenAccountState | null> {
    return this.accounts.get(address) ?? null;
  }

  public async getFinalizedHead(): Promise<{ slot: bigint; signature: null }> {
    return { slot: 123_456n, signature: null };
  }
}

function walletStore(
  database: OrganizationDatabase,
  rpc: SolanaAccountRpcPort,
): WalletStore {
  return new WalletStore({
    database,
    proofDomain: "payops.test",
    providerId: "mainnet-primary",
    rpc,
  });
}

async function signChallenge(
  signer: KeyPairSigner,
  challenge: WalletChallenge,
): Promise<{ challengeId: string; nonce: string; signature: string }> {
  const [signatures] = await signer.signMessages([
    createSignableMessage(challenge.message),
  ]);
  return {
    challengeId: challenge.id,
    nonce: challenge.nonce,
    signature: Buffer.from(signatures![signer.address]!).toString("base64url"),
  };
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
