import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import {
  acceptBootstrapInvitation,
  bootstrapOwner,
  runPlatformMigrations,
  type AuthEmail,
  type EmailDeliveryPort,
} from "@payops/platform";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPayOpsAuth, hashAuthPassword } from "../src/auth/better-auth.js";
import type { ApiConfig } from "../src/config.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_api_auth_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;

describeDatabase("PayOps authentication", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("disables public signup and requires email verification before a session", async () => {
    const email = new RecordingEmailPort();
    const service = createPayOpsAuth(config(), email);
    try {
      const publicSignup = await sendAuth(service.handler, "/sign-up/email", {
        name: "Attacker",
        email: "attacker@example.com",
        password: "correct horse battery staple",
      });
      expect(publicSignup.status).toBe(400);
      await expect(publicSignup.json()).resolves.toMatchObject({
        code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
      });

      const bootstrapEmail = new RecordingEmailPort();
      await bootstrapOwner(
        {
          organizationName: "Acme India",
          email: "owner@example.com",
          invitationBaseUrl: "https://app.example.com/accept-owner",
          now: new Date("2026-08-11T01:00:00.000Z"),
        },
        { databaseUrl: databaseUrl!, email: bootstrapEmail },
      );
      const bootstrapToken = new URL(
        bootstrapEmail.messages[0]!.actionUrl,
      ).searchParams.get("token")!;
      await acceptBootstrapInvitation(
        {
          token: bootstrapToken,
          email: "owner@example.com",
          name: "Acme Owner",
          passwordHash: await hashAuthPassword("correct horse battery staple"),
          now: new Date("2026-08-11T01:05:00.000Z"),
        },
        { databaseUrl: databaseUrl! },
      );

      const unverified = await sendAuth(service.handler, "/sign-in/email", {
        email: "owner@example.com",
        password: "correct horse battery staple",
      });
      expect(unverified.status).not.toBe(200);
      const verification = email.messages.find(
        (message) => message.kind === "email_verification",
      );
      expect(verification).toBeDefined();

      const verified = await service.handler(
        new Request(verification!.actionUrl, {
          method: "GET",
          headers: { origin: "http://127.0.0.1:3000" },
          redirect: "manual",
        }),
      );
      expect([200, 302]).toContain(verified.status);

      const signedIn = await sendAuth(service.handler, "/sign-in/email", {
        email: "owner@example.com",
        password: "correct horse battery staple",
      });
      expect(signedIn.status).toBe(200);
      const cookie = signedIn.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Domain=");
      expect(cookie).not.toContain("Secure");
    } finally {
      await service.close();
    }
  });

  it("rejects hostile origins and keeps API keys out of browser sessions", async () => {
    const service = createPayOpsAuth(config(), new RecordingEmailPort());
    try {
      const response = await service.handler(
        new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          body: JSON.stringify({
            email: "nobody@example.com",
            password: "correct horse battery staple",
          }),
        }),
      );
      expect(response.status).toBe(403);

      const noSession = await service.handler(
        new Request("http://127.0.0.1:3000/api/auth/get-session", {
          headers: {
            origin: "http://127.0.0.1:3000",
            "x-api-key": "payops_invalid",
          },
        }),
      );
      expect(noSession.status).toBe(200);
      await expect(noSession.json()).resolves.toBeNull();
    } finally {
      await service.close();
    }
  });
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
    environment: "test",
    publicApiOrigin: "http://127.0.0.1:3000",
    trustedOrigins: ["http://127.0.0.1:3000"],
    walletProofDomain: "payops.test",
    solanaCluster: "mainnet-beta",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    ingestionProviderId: "mainnet-primary",
    authSecrets: ["uJ9pN3qR8vL2sX6cB5mK7wF4hT1yD0eG9aC8zQ2oI6E"],
    emailDeliveryMode: "test",
    rateLimitMax: 600,
    rateLimitWindowSeconds: 60,
  };
}

async function sendAuth(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
): Promise<Response> {
  return handler(
    new Request(`http://127.0.0.1:3000/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3000",
      },
      body: JSON.stringify(body),
    }),
  );
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
