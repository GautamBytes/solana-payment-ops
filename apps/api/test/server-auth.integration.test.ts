import { createHmac, randomUUID } from "node:crypto";
import { parseLifecycleEventEnvelope } from "@payops/contracts";
import { createSignableMessage, generateKeyPairSigner } from "@solana/kit";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import {
  acceptBootstrapInvitation,
  bootstrapOwner,
  associatedTokenAddress,
  assetBySymbol,
  runPlatformMigrations,
  type AuthEmail,
  type EmailDeliveryPort,
  type SolanaAccountRpcPort,
  type TokenAccountState,
} from "@payops/platform";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import { createPayOpsClient } from "@payops/sdk";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { createPayOpsAuth, hashAuthPassword } from "../src/auth/better-auth.js";
import { buildApiServer } from "../src/server.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_api_server_auth_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;

describeDatabase("Fastify authentication boundary", () => {
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

  it("accepts one invited owner, mounts Better Auth, and rechecks membership", async () => {
    const bootstrapEmail = new RecordingEmailPort();
    const issuedAt = new Date();
    const invitation = await bootstrapOwner(
      {
        organizationName: "Acme India",
        email: "owner@example.com",
        invitationBaseUrl: "https://app.example.com/accept-owner",
        now: issuedAt,
      },
      { databaseUrl: databaseUrl!, email: bootstrapEmail },
    );
    const token = new URL(
      bootstrapEmail.messages[0]!.actionUrl,
    ).searchParams.get("token")!;
    const authEmail = new RecordingEmailPort();
    const rpc = new FakeRpc();
    const server = buildApiServer(config(), {
      emailDelivery: authEmail,
      solanaRpc: rpc,
    });
    try {
      const missingOrigin = await server.inject({
        method: "POST",
        url: "/v1/auth/bootstrap/accept",
        payload: {
          token,
          email: "owner@example.com",
          name: "Acme Owner",
          password: "correct horse battery staple",
        },
      });
      expect(missingOrigin.statusCode).toBe(403);

      const accepted = await server.inject({
        method: "POST",
        url: "/v1/auth/bootstrap/accept",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: {
          token,
          email: "owner@example.com",
          name: "Acme Owner",
          password: "correct horse battery staple",
        },
      });
      expect(accepted.statusCode).toBe(201);
      expect(accepted.json()).toMatchObject({
        organizationId: invitation.organizationId,
        email: "owner@example.com",
      });
      const acceptedUserId = accepted.json<{ userId: string }>().userId;
      const verification = authEmail.messages.find(
        (message) => message.kind === "email_verification",
      );
      expect(verification).toBeDefined();

      const verificationUrl = new URL(verification!.actionUrl);
      const verify = await server.inject({
        method: "GET",
        url: `${verificationUrl.pathname}${verificationUrl.search}`,
        headers: { origin: "http://127.0.0.1:3000" },
      });
      expect([200, 302]).toContain(verify.statusCode);

      const signIn = await server.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: {
          email: "owner@example.com",
          password: "correct horse battery staple",
        },
      });
      expect(signIn.statusCode).toBe(200);
      let cookie = signIn.cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");
      expect(cookie).not.toBe("");

      const organization = await server.inject({
        method: "GET",
        url: "/v1/organization",
        headers: { cookie },
      });
      expect(organization.statusCode).toBe(200);
      expect(organization.json()).toMatchObject({
        organizationId: invitation.organizationId,
        actorKind: "session",
      });

      const enableTwoFactor = await server.inject({
        method: "POST",
        url: "/api/auth/two-factor/enable",
        headers: {
          cookie,
          origin: "http://127.0.0.1:3000",
        },
        payload: { password: "correct horse battery staple" },
      });
      expect(enableTwoFactor.statusCode).toBe(200);
      const twoFactor = enableTwoFactor.json<{
        totpURI: string;
        backupCodes: string[];
      }>();
      expect(twoFactor.backupCodes).toHaveLength(10);
      const secret = new URL(twoFactor.totpURI).searchParams.get("secret")!;
      const verifyTwoFactor = await server.inject({
        method: "POST",
        url: "/api/auth/two-factor/verify-totp",
        headers: {
          cookie,
          origin: "http://127.0.0.1:3000",
        },
        payload: { code: totp(secret), trustDevice: false },
      });
      expect(verifyTwoFactor.statusCode).toBe(200);
      if (verifyTwoFactor.cookies.length > 0) {
        cookie = verifyTwoFactor.cookies
          .map(({ name, value }) => `${name}=${value}`)
          .join("; ");
      }
      const walletSigner = await generateKeyPairSigner();
      await rpc.addWallet(walletSigner.address);
      const walletChallengeResponse = await server.inject({
        method: "POST",
        url: "/v1/merchant-wallets/challenges",
        headers: {
          cookie,
          origin: "http://127.0.0.1:3000",
        },
        payload: { address: walletSigner.address },
      });
      expect(walletChallengeResponse.statusCode).toBe(201);
      const walletChallenge = walletChallengeResponse.json<{
        id: string;
        nonce: string;
        message: string;
      }>();
      const [walletSignatures] = await walletSigner.signMessages([
        createSignableMessage(walletChallenge.message),
      ]);
      const walletPayload = {
        challengeId: walletChallenge.id,
        nonce: walletChallenge.nonce,
        signature: Buffer.from(
          walletSignatures![walletSigner.address]!,
        ).toString("base64url"),
        acceptedAssetSymbols: ["USDC", "USDT"],
      };
      const walletHeaders = {
        cookie,
        origin: "http://127.0.0.1:3000",
        "idempotency-key": "wallet-registration-0001",
      };
      const registeredWallet = await server.inject({
        method: "POST",
        url: "/v1/merchant-wallets",
        headers: walletHeaders,
        payload: walletPayload,
      });
      expect(registeredWallet.statusCode).toBe(201);
      const registeredWalletBody = registeredWallet.json<{ id: string }>();
      const replayedWallet = await server.inject({
        method: "POST",
        url: "/v1/merchant-wallets",
        headers: walletHeaders,
        payload: walletPayload,
      });
      expect(replayedWallet.statusCode).toBe(201);
      expect(
        replayedWallet.rawPayload.equals(registeredWallet.rawPayload),
      ).toBe(true);
      const listedWallets = await server.inject({
        method: "GET",
        url: "/v1/merchant-wallets",
        headers: { cookie },
      });
      expect(listedWallets.json()).toMatchObject({
        data: [
          {
            address: walletSigner.address,
            assets: [{ symbol: "USDC" }, { symbol: "USDT" }],
          },
        ],
      });

      const customerHeaders = {
        cookie,
        origin: "http://127.0.0.1:3000",
        "idempotency-key": "customer-create-0001",
      };
      const customerPayload = {
        externalId: "buyer-001",
        displayName: "Buyer One",
        email: " Buyer@Example.com ",
        metadata: { segment: "pilot" },
      };
      const crossOriginCustomer = await server.inject({
        method: "POST",
        url: "/v1/customers",
        headers: {
          ...customerHeaders,
          origin: "https://attacker.example",
        },
        payload: customerPayload,
      });
      expect(crossOriginCustomer.statusCode).toBe(403);
      expect(crossOriginCustomer.json()).toMatchObject({
        code: "untrusted_origin",
      });
      const createdCustomer = await server.inject({
        method: "POST",
        url: "/v1/customers",
        headers: customerHeaders,
        payload: customerPayload,
      });
      expect(createdCustomer.statusCode).toBe(201);
      const createdCustomerBody = createdCustomer.json<{ id: string }>();
      const replayedCustomer = await server.inject({
        method: "POST",
        url: "/v1/customers",
        headers: customerHeaders,
        payload: customerPayload,
      });
      expect(
        replayedCustomer.rawPayload.equals(createdCustomer.rawPayload),
      ).toBe(true);
      const listedCustomers = await server.inject({
        method: "GET",
        url: "/v1/customers?limit=1",
        headers: { cookie },
      });
      expect(listedCustomers.json()).toMatchObject({
        data: [
          {
            externalId: "buyer-001",
            displayName: "Buyer One",
            email: "buyer@example.com",
          },
        ],
        nextCursor: null,
      });
      const malformedCustomer = await server.inject({
        method: "GET",
        url: `/v1/customers/${"f".repeat(36)}`,
        headers: { cookie },
      });
      expect(malformedCustomer.statusCode).toBe(404);

      const invoicePayload = {
        externalId: "invoice-001",
        customerId: createdCustomerBody.id,
        settlementWalletId: registeredWalletBody.id,
        acceptedAssetSymbols: ["USDC", "USDT"],
        currency: "INR",
        lines: [
          {
            description: "Pilot service",
            quantity: "1.5",
            unitPriceMinorUnits: "10000",
            taxLabel: "GST",
            taxMinorUnits: "2700",
          },
        ],
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        expectedTotals: {
          subtotalMinorUnits: "15000",
          taxMinorUnits: "2700",
          totalMinorUnits: "17700",
        },
      };
      const createdInvoice = await server.inject({
        method: "POST",
        url: "/v1/invoices",
        headers: {
          cookie,
          origin: "http://127.0.0.1:3000",
          "idempotency-key": "invoice-create-0001",
        },
        payload: invoicePayload,
      });
      expect(createdInvoice.statusCode).toBe(201);
      const createdInvoiceBody = createdInvoice.json<{ id: string }>();
      const malformedInvoice = await server.inject({
        method: "GET",
        url: `/v1/invoices/${"f".repeat(36)}`,
        headers: { cookie },
      });
      expect(malformedInvoice.statusCode).toBe(404);
      const faultSql = postgres(databaseUrl!, { max: 1 });
      try {
        await faultSql.unsafe(`
          CREATE FUNCTION reject_api_invoice_event() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$;
          CREATE TRIGGER reject_api_invoice_event
          BEFORE INSERT ON webhook_events
          FOR EACH ROW EXECUTE FUNCTION reject_api_invoice_event();
        `);
        const unavailableIssue = await server.inject({
          method: "POST",
          url: `/v1/invoices/${createdInvoiceBody.id}/issue`,
          headers: {
            cookie,
            origin: "http://127.0.0.1:3000",
            "idempotency-key": "invoice-issue-fault-0001",
          },
          payload: {},
        });
        expect(unavailableIssue.statusCode).toBe(500);
        expect(unavailableIssue.json()).toMatchObject({
          code: "internal_error",
        });
        await faultSql`SELECT set_config('payops.organization_id', ${invitation.organizationId}, false)`;
        await expect(
          faultSql<
            { state: string; invoice_status: string; event_count: number }[]
          >`
            SELECT record.state,
              (SELECT status FROM merchant_invoices
                WHERE id = ${createdInvoiceBody.id}::uuid) AS invoice_status,
              (SELECT count(*)::integer FROM webhook_events
                WHERE source_id = ${createdInvoiceBody.id}) AS event_count
            FROM api_idempotency_records AS record
            WHERE record.route_id = 'invoices.issue'
              AND record.idempotency_key = 'invoice-issue-fault-0001'
          `,
        ).resolves.toEqual([
          { state: "in_progress", invoice_status: "draft", event_count: 0 },
        ]);
      } finally {
        await faultSql.unsafe(`
          DROP TRIGGER IF EXISTS reject_api_invoice_event ON webhook_events;
          DROP FUNCTION IF EXISTS reject_api_invoice_event();
        `);
        await faultSql.end();
      }
      const issuedInvoice = await server.inject({
        method: "POST",
        url: `/v1/invoices/${createdInvoiceBody.id}/issue`,
        headers: {
          cookie,
          origin: "http://127.0.0.1:3000",
          "idempotency-key": "invoice-issue-00001",
        },
        payload: {},
      });
      expect(issuedInvoice.statusCode).toBe(200);
      expect(issuedInvoice.json()).toMatchObject({
        invoice: { status: "issued", version: 2 },
        snapshot: { totalMinorUnits: "17700" },
      });
      const cancelledInvoice = await server.inject({
        method: "POST",
        url: `/v1/invoices/${createdInvoiceBody.id}/cancel`,
        headers: {
          cookie,
          origin: "http://127.0.0.1:3000",
          "idempotency-key": "invoice-cancel-0001",
        },
        payload: { reasonCode: "customer_request" },
      });
      expect(cancelledInvoice.statusCode).toBe(200);
      expect(cancelledInvoice.json()).toMatchObject({
        status: "cancelled",
        version: 3,
      });

      const createKey = await server.inject({
        method: "POST",
        url: "/api/auth/api-key/create",
        headers: {
          cookie,
          origin: "http://127.0.0.1:3000",
        },
        payload: {
          configId: "payops-organization",
          name: "merchant-sdk",
          organizationId: invitation.organizationId,
        },
      });
      expect({
        statusCode: createKey.statusCode,
        body: createKey.json(),
      }).toMatchObject({ statusCode: 200, body: { key: expect.any(String) } });
      const rawApiKey = createKey.json<{ key: string }>().key;
      expect(rawApiKey.startsWith("payops_")).toBe(true);
      const apiKeyOrganization = await server.inject({
        method: "GET",
        url: "/v1/organization",
        headers: { "x-api-key": rawApiKey },
      });
      expect(apiKeyOrganization.statusCode).toBe(200);
      expect(apiKeyOrganization.json()).toMatchObject({
        organizationId: invitation.organizationId,
        actorKind: "api_key",
      });

      const sdk = createPayOpsClient({
        baseUrl: "https://api.example.com",
        apiKey: rawApiKey,
        fetch: fastifyFetch(server),
      });
      await expect(
        sdk.getInvoice(createdInvoiceBody.id),
      ).resolves.toMatchObject({
        id: createdInvoiceBody.id,
        status: "cancelled",
        totalMinorUnits: "17700",
      });
      await expect(sdk.listInvoices({ limit: 1 })).resolves.toMatchObject({
        data: [{ id: createdInvoiceBody.id }],
        nextCursor: null,
      });

      const secondEmail = new RecordingEmailPort();
      const secondInvitation = await bootstrapOwner(
        {
          organizationName: "Other Merchant",
          email: "other-owner@example.com",
          invitationBaseUrl: "https://app.example.com/accept-owner",
          now: new Date(),
        },
        { databaseUrl: databaseUrl!, email: secondEmail },
      );
      const secondToken = new URL(
        secondEmail.messages[0]!.actionUrl,
      ).searchParams.get("token")!;
      const secondOwner = await acceptBootstrapInvitation(
        {
          token: secondToken,
          email: "other-owner@example.com",
          name: "Other Owner",
          passwordHash: await hashAuthPassword(
            "another correct horse battery staple",
          ),
          now: new Date(),
        },
        { databaseUrl: databaseUrl! },
      );
      const secondAuth = createPayOpsAuth(config(), new RecordingEmailPort());
      try {
        const secondKey = await secondAuth.auth.api.createApiKey({
          body: {
            configId: "payops-organization",
            name: "other-merchant",
            organizationId: secondInvitation.organizationId,
            userId: secondOwner.userId,
            permissions: {
              payops: [
                "organizationRead",
                "walletRead",
                "customerRead",
                "customerWrite",
                "invoiceRead",
                "invoiceWrite",
                "invoiceIssue",
              ],
            },
          },
        });
        const otherSdk = createPayOpsClient({
          baseUrl: "https://api.example.com",
          apiKey: secondKey.key,
          fetch: fastifyFetch(server),
        });
        await expect(
          otherSdk.getCustomer(createdCustomerBody.id),
        ).rejects.toMatchObject({
          status: 404,
          code: "customer_not_found",
        });
        await expect(
          otherSdk.getInvoice(createdInvoiceBody.id),
        ).rejects.toMatchObject({
          status: 404,
          code: "invoice_not_found",
        });
        await expect(
          otherSdk.createCustomer(customerPayload, {
            idempotencyKey: "customer-create-0001",
          }),
        ).resolves.toMatchObject({
          organizationId: secondInvitation.organizationId,
          externalId: "buyer-001",
        });
        await expect(
          otherSdk.listInvoices({ customerId: createdCustomerBody.id }),
        ).resolves.toEqual({ data: [], nextCursor: null });
      } finally {
        await secondAuth.close();
      }

      const sql = postgres(databaseUrl!, { max: 1 });
      try {
        await sql`SELECT set_config('payops.organization_id', ${invitation.organizationId}, false)`;
        await expect(
          sql<{ count: number }[]>`
            SELECT count(*)::integer AS count FROM audit_events
            WHERE action = 'wallet.register' AND outcome = 'succeeded'
          `,
        ).resolves.toEqual([{ count: 1 }]);
        const lifecycleEvents = await sql<
          { event_type: string; payload: string }[]
        >`
            SELECT event_type, payload
            FROM webhook_events
            WHERE organization_id = ${invitation.organizationId}::uuid
              AND source_id = ${createdInvoiceBody.id}
            ORDER BY event_type
          `;
        expect(lifecycleEvents.map(({ event_type }) => event_type)).toEqual([
          "invoice.cancelled",
          "invoice.issued",
        ]);
        for (const event of lifecycleEvents) {
          expect(
            parseLifecycleEventEnvelope(JSON.parse(event.payload)),
          ).not.toBe(null);
        }
        await expect(
          sql<{ action: string; count: number }[]>`
            SELECT action, count(*)::integer AS count
            FROM audit_events
            WHERE organization_id = ${invitation.organizationId}::uuid
              AND action IN (
              'customer.create', 'invoice.create', 'invoice.issue',
              'invoice.cancel', 'wallet.register'
            )
            GROUP BY action
            ORDER BY action
          `,
        ).resolves.toEqual([
          { action: "customer.create", count: 1 },
          { action: "invoice.cancel", count: 1 },
          { action: "invoice.create", count: 1 },
          { action: "invoice.issue", count: 1 },
          { action: "wallet.register", count: 1 },
        ]);
        const protectedCodes = await sql<
          { backup_codes: string; two_factor_enabled: boolean }[]
        >`
          SELECT factor.backup_codes, identity.two_factor_enabled
          FROM two_factor AS factor
          JOIN "user" AS identity ON identity.id = factor.user_id
          WHERE identity.id = ${acceptedUserId}
        `;
        expect(protectedCodes[0]?.two_factor_enabled).toBe(true);
        for (const code of twoFactor.backupCodes) {
          expect(protectedCodes[0]?.backup_codes).not.toContain(code);
        }
        const replacementOwnerId = randomUUID();
        const now = new Date().toISOString();
        await sql`
          INSERT INTO "user" (
            id, name, email, email_verified, created_at, updated_at
          ) VALUES (
            ${replacementOwnerId}, 'Replacement', 'replacement@example.com',
            true, ${now}, ${now}
          )
        `;
        await sql`
          INSERT INTO member (
            id, organization_id, user_id, role, created_at
          ) VALUES (
            ${randomUUID()}, ${invitation.organizationId}::uuid,
            ${replacementOwnerId}, 'owner', ${now}
          )
        `;
        await sql`DELETE FROM member WHERE user_id = ${acceptedUserId}`;
      } finally {
        await sql.end();
      }

      const removed = await server.inject({
        method: "GET",
        url: "/v1/organization",
        headers: { cookie },
      });
      expect(removed.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});

function fastifyFetch(server: FastifyInstance): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers));
    const response = await server.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) responseHeaders.set(name, String(value));
    }
    return new Response(new Uint8Array(response.rawPayload), {
      status: response.statusCode,
      headers: responseHeaders,
    });
  };
}

class RecordingEmailPort implements EmailDeliveryPort {
  public readonly messages: AuthEmail[] = [];

  public async send(message: AuthEmail): Promise<void> {
    this.messages.push(message);
  }
}

class FakeRpc implements SolanaAccountRpcPort {
  readonly #accounts = new Map<string, TokenAccountState>();

  public async addWallet(walletAddress: string): Promise<void> {
    for (const symbol of ["USDC", "USDT"] as const) {
      const asset = assetBySymbol(symbol);
      const tokenAccount = await associatedTokenAddress(walletAddress, asset);
      this.#accounts.set(tokenAccount, {
        address: tokenAccount,
        owner: walletAddress,
        mint: asset.mint,
        programOwner: asset.tokenProgram,
      });
    }
  }

  public async getTokenAccount(
    address: string,
  ): Promise<TokenAccountState | null> {
    return this.#accounts.get(address) ?? null;
  }

  public async getFinalizedHead(): Promise<{ slot: bigint; signature: null }> {
    return { slot: 123_456n, signature: null };
  }
}

function config(): ApiConfig {
  return {
    databaseUrl: databaseUrl!,
    environment: "test",
    publicApiOrigin: "http://127.0.0.1:3000",
    checkoutOrigin: "http://127.0.0.1:3001",
    trustedOrigins: ["http://127.0.0.1:3000"],
    walletProofDomain: "payops.test",
    solanaCluster: "mainnet-beta",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    ingestionProviderId: "mainnet-primary",
    authSecrets: ["uJ9pN3qR8vL2sX6cB5mK7wF4hT1yD0eG9aC8zQ2oI6E"],
    checkoutTokenKeys: [
      {
        id: "checkout-v1",
        secret: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      },
    ],
    pythHermesEndpoint: "https://pyth.example/hermes",
    pythAccessToken: "test-provider-secret",
    pythFeedIds: { USDC: "a".repeat(64), USDT: "b".repeat(64) },
    ecbEndpoint: "https://data.example/service",
    emailDeliveryMode: "test",
    rateLimitMax: 600,
    rateLimitWindowSeconds: 60,
  };
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function totp(base32Secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of base32Secret.replaceAll("=", "").toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("invalid_totp_secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  const counter = BigInt(Math.floor(now / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(message)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return (binary % 1_000_000).toString().padStart(6, "0");
}
