import { createHash } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acceptBootstrapInvitation,
  bootstrapOwner,
  type AuthEmail,
  type EmailDeliveryPort,
} from "../src/index.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_bootstrap_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;

describeDatabase("owner bootstrap", () => {
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

  it("stores only a digest, resends safely, and returns no bearer secret", async () => {
    const email = new RecordingEmailPort();
    const first = await bootstrapOwner(
      {
        organizationName: "Acme India",
        email: " OWNER@Example.com ",
        invitationBaseUrl: "https://app.example.com/accept-owner",
        now: new Date("2026-08-11T01:00:00.000Z"),
      },
      { databaseUrl: databaseUrl!, email },
    );
    expect(first).toEqual({
      organizationId: expect.any(String),
      invitationId: expect.any(String),
      expiresAt: new Date("2026-08-12T01:00:00.000Z"),
    });
    expect(JSON.stringify(first)).not.toContain("token");
    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]?.to).toBe("owner@example.com");
    const token = tokenFrom(email.messages[0]!);

    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      const rows = await sql<
        { token_digest: string; normalized_email: string }[]
      >`
        SELECT token_digest, normalized_email
        FROM platform_bootstrap_invitations
      `;
      expect(rows).toEqual([
        {
          token_digest: createHash("sha256").update(token).digest("hex"),
          normalized_email: "owner@example.com",
        },
      ]);
      expect(rows[0]?.token_digest).not.toBe(token);

      const resent = await bootstrapOwner(
        {
          organizationName: "Acme India",
          email: "owner@example.com",
          invitationBaseUrl: "https://app.example.com/accept-owner",
          now: new Date("2026-08-11T02:00:00.000Z"),
        },
        { databaseUrl: databaseUrl!, email },
      );
      expect(resent.organizationId).toBe(first.organizationId);
      expect(resent.invitationId).toBe(first.invitationId);
      expect(email.messages).toHaveLength(2);
      expect(tokenFrom(email.messages[1]!)).not.toBe(token);
      await expect(
        sql`SELECT count(*)::integer AS count FROM organization`,
      ).resolves.toMatchObject([{ count: 2 }]);
    } finally {
      await sql.end();
    }
  });

  it("accepts the latest token exactly once and creates an unverified owner atomically", async () => {
    const email = new RecordingEmailPort();
    const invitation = await bootstrapOwner(
      {
        organizationName: "Acme India",
        email: "owner@example.com",
        invitationBaseUrl: "https://app.example.com/accept-owner",
        now: new Date("2026-08-11T01:00:00.000Z"),
      },
      { databaseUrl: databaseUrl!, email },
    );
    const token = tokenFrom(email.messages[0]!);
    const accepted = await acceptBootstrapInvitation(
      {
        token,
        email: "OWNER@example.com",
        name: "Acme Owner",
        passwordHash: "better-auth-compatible-password-hash",
        now: new Date("2026-08-11T01:05:00.000Z"),
      },
      { databaseUrl: databaseUrl! },
    );
    expect(accepted).toMatchObject({
      organizationId: invitation.organizationId,
      email: "owner@example.com",
      userId: expect.any(String),
    });

    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await expect(
        sql<{ email_verified: boolean; role: string; consumed: boolean }[]>`
          SELECT u.email_verified, m.role, i.consumed_at IS NOT NULL AS consumed
          FROM "user" AS u
          JOIN member AS m ON m.user_id = u.id
          JOIN platform_bootstrap_invitations AS i
            ON i.organization_id = m.organization_id
          WHERE u.id = ${accepted.userId}
        `,
      ).resolves.toEqual([
        { email_verified: false, role: "owner", consumed: true },
      ]);
      await expect(
        sql<{ password: string | null }[]>`
          SELECT password FROM account WHERE user_id = ${accepted.userId}
        `,
      ).resolves.toEqual([
        { password: "better-auth-compatible-password-hash" },
      ]);
    } finally {
      await sql.end();
    }

    await expect(
      acceptBootstrapInvitation(
        {
          token,
          email: "owner@example.com",
          name: "Acme Owner",
          passwordHash: "another-hash",
          now: new Date("2026-08-11T01:06:00.000Z"),
        },
        { databaseUrl: databaseUrl! },
      ),
    ).rejects.toMatchObject({ code: "invalid_bootstrap_invitation" });
  });

  it("rejects expired or mismatched invitations without partial identity rows", async () => {
    const email = new RecordingEmailPort();
    await bootstrapOwner(
      {
        organizationName: "Acme India",
        email: "owner@example.com",
        invitationBaseUrl: "https://app.example.com/accept-owner",
        now: new Date("2026-08-11T01:00:00.000Z"),
      },
      { databaseUrl: databaseUrl!, email },
    );
    const token = tokenFrom(email.messages[0]!);
    for (const input of [
      { token: "A".repeat(43), email: "owner@example.com" },
      { token, email: "other@example.com" },
      {
        token,
        email: "owner@example.com",
        now: new Date("2026-08-12T01:00:00.001Z"),
      },
    ]) {
      await expect(
        acceptBootstrapInvitation(
          {
            token: input.token,
            email: input.email,
            name: "Acme Owner",
            passwordHash: "hash",
            now: input.now ?? new Date("2026-08-11T01:05:00.000Z"),
          },
          { databaseUrl: databaseUrl! },
        ),
      ).rejects.toMatchObject({ code: "invalid_bootstrap_invitation" });
    }
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await expect(
        sql`SELECT count(*)::integer AS count FROM "user"`,
      ).resolves.toMatchObject([{ count: 0 }]);
      await expect(
        sql`SELECT count(*)::integer AS count FROM member`,
      ).resolves.toMatchObject([{ count: 0 }]);
    } finally {
      await sql.end();
    }
  });

  it("prevents deletion or demotion of the last owner at the database boundary", async () => {
    const email = new RecordingEmailPort();
    await bootstrapOwner(
      {
        organizationName: "Acme India",
        email: "owner@example.com",
        invitationBaseUrl: "https://app.example.com/accept-owner",
        now: new Date("2026-08-11T01:00:00.000Z"),
      },
      { databaseUrl: databaseUrl!, email },
    );
    const accepted = await acceptBootstrapInvitation(
      {
        token: tokenFrom(email.messages[0]!),
        email: "owner@example.com",
        name: "Acme Owner",
        passwordHash: "hash",
        now: new Date("2026-08-11T01:01:00.000Z"),
      },
      { databaseUrl: databaseUrl! },
    );
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await expect(
        sql`UPDATE member SET role = 'viewer' WHERE user_id = ${accepted.userId}`,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        sql`DELETE FROM member WHERE user_id = ${accepted.userId}`,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
    }
  });
});

class RecordingEmailPort implements EmailDeliveryPort {
  public readonly messages: AuthEmail[] = [];

  public async send(message: AuthEmail): Promise<void> {
    this.messages.push(message);
  }
}

function tokenFrom(message: AuthEmail): string {
  return new URL(message.actionUrl).searchParams.get("token") ?? "";
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
