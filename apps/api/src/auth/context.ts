import {
  isOrganizationRole,
  permissionsForRole,
  type OrganizationPermissions,
  type OrganizationRole,
} from "@payops/platform";
import postgres from "postgres";

export class AuthenticationError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Authentication failed");
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export type RequestActor = SessionActor | ApiKeyActor;

export interface AuthContextResolver {
  readonly resolve: (headers: Headers) => Promise<RequestActor>;
  readonly close: () => Promise<void>;
}

export interface SessionActor {
  readonly kind: "session";
  readonly actorId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly permissions: OrganizationPermissions;
  readonly sessionCreatedAt: Date;
  readonly twoFactorEnabled: boolean;
}

export interface ApiKeyActor {
  readonly kind: "api_key";
  readonly actorId: string;
  readonly organizationId: string;
  readonly permissions: OrganizationPermissions;
}

interface AuthApiPort {
  readonly api: {
    getSession(input: {
      readonly headers: Headers;
      readonly query?: { readonly disableCookieCache?: boolean };
    }): Promise<unknown>;
    verifyApiKey(input: {
      readonly body: {
        readonly key: string;
        readonly configId: string;
      };
    }): Promise<unknown>;
  };
}

export function createAuthContextResolver(
  auth: AuthApiPort,
  databaseUrl: string,
): AuthContextResolver {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined });
  return {
    resolve: async (headers: Headers): Promise<RequestActor> => {
      if (headers.has("cookie")) {
        return resolveSession(auth, sql, headers);
      }
      const key = headers.get("x-api-key");
      if (key !== null) {
        return resolveApiKey(auth, key);
      }
      throw new AuthenticationError("authentication_required");
    },
    close: async () => sql.end(),
  };
}

export function requireSensitiveSession(
  actor: RequestActor,
  now: Date,
  options: { readonly requireTwoFactor: boolean },
): SessionActor {
  if (actor.kind !== "session") {
    throw new AuthenticationError("session_authentication_required");
  }
  const sessionAge = now.getTime() - actor.sessionCreatedAt.getTime();
  if (
    !Number.isFinite(now.getTime()) ||
    sessionAge < -30_000 ||
    sessionAge > 15 * 60 * 1_000
  ) {
    throw new AuthenticationError("fresh_authentication_required");
  }
  if (options.requireTwoFactor && !actor.twoFactorEnabled) {
    throw new AuthenticationError("two_factor_required");
  }
  return actor;
}

async function resolveSession(
  auth: AuthApiPort,
  sql: postgres.Sql,
  headers: Headers,
): Promise<SessionActor> {
  const value = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!isSessionResult(value) || !value.user.emailVerified) {
    throw new AuthenticationError("invalid_session");
  }
  const activeOrganizationId = value.session.activeOrganizationId;
  const memberships = await sql<{ organization_id: string; role: string }[]>`
    SELECT organization_id::text, role
    FROM member
    WHERE user_id = ${value.user.id}
      AND (
        ${activeOrganizationId ?? null}::uuid IS NULL
        OR organization_id = ${activeOrganizationId ?? null}::uuid
      )
    ORDER BY organization_id
    LIMIT 2
  `;
  if (memberships.length !== 1) {
    throw new AuthenticationError("organization_membership_required");
  }
  const membership = memberships[0]!;
  if (!isOrganizationRole(membership.role)) {
    throw new AuthenticationError("invalid_organization_membership");
  }
  return {
    kind: "session",
    actorId: value.user.id,
    organizationId: membership.organization_id,
    role: membership.role,
    permissions: permissionsForRole(membership.role),
    sessionCreatedAt: value.session.createdAt,
    twoFactorEnabled: value.user.twoFactorEnabled === true,
  };
}

async function resolveApiKey(
  auth: AuthApiPort,
  rawKey: string,
): Promise<ApiKeyActor> {
  const verification = await auth.api.verifyApiKey({
    body: { key: rawKey, configId: "payops-organization" },
  });
  if (!isVerifiedApiKey(verification)) {
    throw new AuthenticationError("invalid_api_key");
  }
  const allowed: OrganizationPermissions = {
    organizationRead: true,
    memberAdmin: false,
    apiKeyAdmin: false,
    walletRead: true,
    walletAdmin: false,
    customerRead: true,
    customerWrite: true,
    invoiceRead: true,
    invoiceWrite: true,
    invoiceIssue: true,
    paymentReview: true,
    accountingRead: true,
  };
  const requested = verification.key.permissions?.payops ?? [];
  const enabled = (permission: keyof OrganizationPermissions): boolean =>
    requested.includes(permission) && allowed[permission];
  const permissions: OrganizationPermissions = {
    organizationRead: enabled("organizationRead"),
    memberAdmin: enabled("memberAdmin"),
    apiKeyAdmin: enabled("apiKeyAdmin"),
    walletRead: enabled("walletRead"),
    walletAdmin: enabled("walletAdmin"),
    customerRead: enabled("customerRead"),
    customerWrite: enabled("customerWrite"),
    invoiceRead: enabled("invoiceRead"),
    invoiceWrite: enabled("invoiceWrite"),
    invoiceIssue: enabled("invoiceIssue"),
    paymentReview: enabled("paymentReview"),
    accountingRead: enabled("accountingRead"),
  };
  return {
    kind: "api_key",
    actorId: verification.key.id,
    organizationId: verification.key.referenceId,
    permissions: Object.freeze(permissions),
  };
}

function isSessionResult(value: unknown): value is {
  readonly session: {
    readonly createdAt: Date;
    readonly activeOrganizationId?: string | null;
  };
  readonly user: {
    readonly id: string;
    readonly emailVerified: boolean;
    readonly twoFactorEnabled?: boolean;
  };
} {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.session === null ||
    typeof candidate.session !== "object" ||
    candidate.user === null ||
    typeof candidate.user !== "object"
  ) {
    return false;
  }
  const session = candidate.session as Record<string, unknown>;
  const user = candidate.user as Record<string, unknown>;
  return (
    session.createdAt instanceof Date &&
    typeof user.id === "string" &&
    typeof user.emailVerified === "boolean"
  );
}

function isVerifiedApiKey(value: unknown): value is {
  readonly valid: true;
  readonly key: {
    readonly id: string;
    readonly referenceId: string;
    readonly permissions?: Record<string, string[]> | null;
  };
} {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.valid !== true ||
    candidate.key === null ||
    typeof candidate.key !== "object"
  ) {
    return false;
  }
  const key = candidate.key as Record<string, unknown>;
  const permissions = key.permissions;
  const payops =
    permissions !== null && typeof permissions === "object"
      ? (permissions as Record<string, unknown>).payops
      : undefined;
  return (
    typeof key.id === "string" &&
    key.id.length > 0 &&
    typeof key.referenceId === "string" &&
    key.referenceId.length > 0 &&
    (payops === undefined ||
      (Array.isArray(payops) &&
        payops.every((value) => typeof value === "string")))
  );
}
