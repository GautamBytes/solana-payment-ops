import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import {
  acceptBootstrapInvitation,
  bootstrapOwner,
  type AuthEmail,
  type EmailDeliveryPort,
} from "@payops/platform";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPayOpsAuth, hashAuthPassword } from "../src/auth/better-auth.js";
import {
  AuthenticationError,
  createAuthContextResolver,
  requireSensitiveSession,
} from "../src/auth/context.js";
import type { ApiConfig } from "../src/config.js";
import { buildApiServer } from "../src/server.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_api_key_auth_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;

describeDatabase("organization API-key authentication", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runTestPlatformMigrations(databaseUrl!);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(databaseUrl!);
    await admin?.end();
  });

  it("resolves a hashed organization key without creating or downgrading a session", async () => {
    const service = createPayOpsAuth(config(), new RecordingEmailPort());
    const resolver = createAuthContextResolver(service.auth, databaseUrl!);
    try {
      const owner = await createVerifiedOwner();
      const signIn = await service.handler(
        new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify({
            email: "owner@example.com",
            password: "correct horse battery staple",
          }),
        }),
      );
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.get("set-cookie")!;
      const blockedBrowserKey = await service.handler(
        new Request("http://127.0.0.1:3000/api/auth/api-key/create", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify({
            name: "blocked-before-two-factor",
            organizationId: owner.organizationId,
          }),
        }),
      );
      expect(blockedBrowserKey.status).toBe(403);
      await expect(blockedBrowserKey.json()).resolves.toMatchObject({
        code: "two_factor_required",
      });
      const created = await service.auth.api.createApiKey({
        body: {
          configId: "payops-organization",
          name: "merchant-sdk",
          organizationId: owner.organizationId,
          userId: owner.userId,
          permissions: {
            payops: ["customerRead", "customerWrite", "memberAdmin"],
          },
        },
      });
      expect(created.key.startsWith("payops_")).toBe(true);

      const actor = await resolver.resolve(
        new Headers({ "x-api-key": created.key }),
      );
      expect(actor).toMatchObject({
        kind: "api_key",
        organizationId: owner.organizationId,
        permissions: {
          customerRead: true,
          customerWrite: true,
          memberAdmin: false,
          walletAdmin: false,
        },
      });
      const api = buildApiServer(config(), {
        emailDelivery: new RecordingEmailPort(),
      });
      try {
        const forbiddenOrganization = await api.inject({
          method: "GET",
          url: "/v1/organization",
          headers: { "x-api-key": created.key },
        });
        expect(forbiddenOrganization.statusCode).toBe(403);
        expect(forbiddenOrganization.json()).toMatchObject({
          code: "forbidden",
        });
      } finally {
        await api.close();
      }
      expect(() =>
        requireSensitiveSession(actor, new Date(), {
          requireTwoFactor: false,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "session_authentication_required" }),
      );

      await expect(
        resolver.resolve(
          new Headers({
            cookie: "payops.session_token=invalid",
            "x-api-key": created.key,
          }),
        ),
      ).rejects.toBeInstanceOf(AuthenticationError);

      const inspection = postgres(databaseUrl!, { max: 1 });
      try {
        const rows = await inspection<{ key: string }[]>`
          SELECT key FROM apikey
        `;
        expect(rows[0]?.key).not.toBe(created.key);
      } finally {
        await inspection.end();
      }
    } finally {
      await Promise.all([resolver.close(), service.close()]);
    }
  });

  async function createVerifiedOwner(): Promise<{
    readonly organizationId: string;
    readonly userId: string;
  }> {
    const email = new RecordingEmailPort();
    const invitation = await bootstrapOwner(
      {
        organizationName: "Acme India",
        email: "owner@example.com",
        invitationBaseUrl: "https://app.example.com/accept-owner",
        now: new Date(),
      },
      { databaseUrl: databaseUrl!, email },
    );
    const token = new URL(email.messages[0]!.actionUrl).searchParams.get(
      "token",
    )!;
    const accepted = await acceptBootstrapInvitation(
      {
        token,
        email: "owner@example.com",
        name: "Acme Owner",
        passwordHash: await hashAuthPassword("correct horse battery staple"),
        now: new Date(),
      },
      { databaseUrl: databaseUrl! },
    );
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await sql`UPDATE "user" SET email_verified = true WHERE id = ${accepted.userId}`;
    } finally {
      await sql.end();
    }
    return {
      organizationId: invitation.organizationId,
      userId: accepted.userId,
    };
  }
});

class RecordingEmailPort implements EmailDeliveryPort {
  public readonly messages: AuthEmail[] = [];
  public async send(message: AuthEmail): Promise<void> {
    this.messages.push(message);
  }
}

function config(): ApiConfig {
  return {
    databaseUrl: databaseUrl!,
    productionControlDatabaseUrl: databaseUrl!,
    readinessVerifierDatabaseUrl: databaseUrl!,
    environment: "test",
    publicApiOrigin: "http://127.0.0.1:3000",
    checkoutOrigin: "http://127.0.0.1:3001",
    trustedOrigins: ["http://127.0.0.1:3000"],
    walletProofDomain: "payops.test",
    solanaCluster: "mainnet-beta",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    ingestionProviderId: "mainnet-primary",
    rpc: {
      mode: "dual_provider",
      cluster: "mainnet-beta",
      primary: {
        providerId: "mainnet-primary",
        endpointEnvironment: "TEST_RPC_URL",
        endpoint: "https://api.mainnet-beta.solana.com",
      },
      secondary: {
        providerId: "mainnet-secondary",
        endpointEnvironment: "TEST_SECONDARY_RPC_URL",
        endpoint: "https://secondary.mainnet.example",
      },
    },
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
