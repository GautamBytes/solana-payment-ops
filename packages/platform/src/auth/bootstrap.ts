import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { EmailDeliveryPort } from "./email-port.js";

const invitationLifetimeMs = 24 * 60 * 60 * 1_000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class BootstrapError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(
      "Owner bootstrap failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "BootstrapError";
    this.code = code;
  }
}

export interface BootstrapOwnerInput {
  readonly organizationName: string;
  readonly email: string;
  readonly invitationBaseUrl: string;
  readonly now: Date;
}

export interface BootstrapOwnerResult {
  readonly organizationId: string;
  readonly invitationId: string;
  readonly expiresAt: Date;
}

export async function bootstrapOwner(
  input: BootstrapOwnerInput,
  dependencies: {
    readonly databaseUrl: string;
    readonly email: EmailDeliveryPort;
  },
): Promise<BootstrapOwnerResult> {
  const organizationName = normalizeOrganizationName(input.organizationName);
  const normalizedEmail = normalizeEmail(input.email);
  const invitationBaseUrl = parseInvitationBaseUrl(input.invitationBaseUrl);
  assertValidDate(input.now);
  const slug = organizationSlug(organizationName);
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = digestToken(token);
  const expiresAt = new Date(input.now.getTime() + invitationLifetimeMs);
  const sql = postgres(dependencies.databaseUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  let result: BootstrapOwnerResult;
  try {
    result = await sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${`bootstrap:${slug}`}, 0))
      `;
      const organizations = await transaction<{ id: string; name: string }[]>`
        SELECT id::text, name FROM organization WHERE slug = ${slug}
        FOR UPDATE
      `;
      const organization = organizations[0];
      const organizationId = organization?.id ?? randomUUID();
      if (
        organization !== undefined &&
        organization.name !== organizationName
      ) {
        throw new BootstrapError("bootstrap_identity_conflict");
      }
      if (organization === undefined) {
        await transaction`
          INSERT INTO organization (id, name, slug, created_at, metadata)
          VALUES (
            ${organizationId}::uuid, ${organizationName}, ${slug},
            ${input.now.toISOString()}, '{"kind":"merchant"}'
          )
        `;
      }
      const owners = await transaction<{ present: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM member
          WHERE organization_id = ${organizationId}::uuid AND role = 'owner'
        ) AS present
      `;
      if (owners[0]?.present === true) {
        throw new BootstrapError("organization_already_bootstrapped");
      }
      const pending = await transaction<
        { id: string; normalized_email: string }[]
      >`
        SELECT id::text, normalized_email
        FROM platform_bootstrap_invitations
        WHERE organization_id = ${organizationId}::uuid
          AND consumed_at IS NULL
        FOR UPDATE
      `;
      if (
        pending[0] !== undefined &&
        pending[0].normalized_email !== normalizedEmail
      ) {
        throw new BootstrapError("bootstrap_identity_conflict");
      }
      const invitationId = pending[0]?.id ?? randomUUID();
      if (pending[0] === undefined) {
        await transaction`
          INSERT INTO platform_bootstrap_invitations (
            id, organization_id, normalized_email, token_digest, expires_at,
            created_at
          ) VALUES (
            ${invitationId}::uuid, ${organizationId}::uuid, ${normalizedEmail},
            ${tokenDigest}, ${expiresAt.toISOString()}, ${input.now.toISOString()}
          )
        `;
      } else {
        await transaction`
          UPDATE platform_bootstrap_invitations SET
            token_digest = ${tokenDigest},
            expires_at = ${expiresAt.toISOString()}
          WHERE id = ${invitationId}::uuid AND consumed_at IS NULL
        `;
      }
      return { organizationId, invitationId, expiresAt };
    });
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("bootstrap_unavailable", error);
  } finally {
    await sql.end();
  }

  invitationBaseUrl.searchParams.set("token", token);
  invitationBaseUrl.searchParams.set("email", normalizedEmail);
  await dependencies.email.send({
    kind: "bootstrap_owner",
    to: normalizedEmail,
    actionUrl: invitationBaseUrl.toString(),
    expiresAt,
    organizationName,
  });
  return result;
}

export interface AcceptBootstrapInvitationInput {
  readonly token: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly now: Date;
}

export interface AcceptedBootstrapOwner {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
}

export async function acceptBootstrapInvitation(
  input: AcceptBootstrapInvitationInput,
  dependencies: { readonly databaseUrl: string },
): Promise<AcceptedBootstrapOwner> {
  const normalizedEmail = normalizeEmail(input.email);
  const name = normalizePersonName(input.name);
  assertValidDate(input.now);
  if (!tokenPattern.test(input.token) || input.passwordHash.length === 0) {
    throw new BootstrapError("invalid_bootstrap_invitation");
  }
  const tokenDigest = digestToken(input.token);
  const sql = postgres(dependencies.databaseUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    return await sql.begin(async (transaction) => {
      const invitations = await transaction<
        {
          id: string;
          organization_id: string;
          normalized_email: string;
          expires_at: Date;
          consumed_at: Date | null;
        }[]
      >`
        SELECT id::text, organization_id::text, normalized_email,
          expires_at, consumed_at
        FROM platform_bootstrap_invitations
        WHERE token_digest = ${tokenDigest}
        FOR UPDATE
      `;
      const invitation = invitations[0];
      if (
        invitation === undefined ||
        invitation.normalized_email !== normalizedEmail ||
        invitation.consumed_at !== null ||
        invitation.expires_at.getTime() <= input.now.getTime()
      ) {
        throw new BootstrapError("invalid_bootstrap_invitation");
      }
      const existing = await transaction<{ present: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM "user" WHERE email = ${normalizedEmail}
        ) AS present
      `;
      if (existing[0]?.present === true) {
        throw new BootstrapError("bootstrap_identity_conflict");
      }
      const userId = randomUUID();
      const accountId = randomUUID();
      const memberId = randomUUID();
      const now = input.now.toISOString();
      await transaction`
        INSERT INTO "user" (
          id, name, email, email_verified, created_at, updated_at
        ) VALUES (${userId}, ${name}, ${normalizedEmail}, false, ${now}, ${now})
      `;
      await transaction`
        INSERT INTO account (
          id, account_id, provider_id, user_id, password, created_at, updated_at
        ) VALUES (
          ${accountId}, ${userId}, 'credential', ${userId},
          ${input.passwordHash}, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO member (id, organization_id, user_id, role, created_at)
        VALUES (
          ${memberId}, ${invitation.organization_id}::uuid, ${userId},
          'owner', ${now}
        )
      `;
      const consumed = await transaction<{ id: string }[]>`
        UPDATE platform_bootstrap_invitations
        SET consumed_at = ${now}
        WHERE id = ${invitation.id}::uuid AND consumed_at IS NULL
        RETURNING id::text
      `;
      if (consumed.length !== 1) {
        throw new BootstrapError("invalid_bootstrap_invitation");
      }
      return {
        userId,
        organizationId: invitation.organization_id,
        email: normalizedEmail,
      };
    });
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("bootstrap_unavailable", error);
  } finally {
    await sql.end();
  }
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !emailPattern.test(normalized)
  ) {
    throw new BootstrapError("invalid_bootstrap_identity");
  }
  return normalized;
}

function normalizeOrganizationName(value: string): string {
  const normalized = value.trim().normalize("NFC");
  if ([...normalized].length < 1 || [...normalized].length > 100) {
    throw new BootstrapError("invalid_bootstrap_identity");
  }
  return normalized;
}

function normalizePersonName(value: string): string {
  const normalized = value.trim().normalize("NFC");
  if ([...normalized].length < 1 || [...normalized].length > 100) {
    throw new BootstrapError("invalid_bootstrap_identity");
  }
  return normalized;
}

function organizationSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 48);
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${base || "organization"}-${suffix}`;
}

function parseInvitationBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BootstrapError("invalid_bootstrap_configuration");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BootstrapError("invalid_bootstrap_configuration");
  }
  return url;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new BootstrapError("invalid_bootstrap_configuration");
  }
}
