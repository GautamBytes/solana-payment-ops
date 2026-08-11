import { apiKey } from "@better-auth/api-key";
import {
  betterAuthSchema,
  type AuthEmail,
  type EmailDeliveryPort,
} from "@payops/platform";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword } from "better-auth/crypto";
import { organization, twoFactor } from "better-auth/plugins";
import { defaultAc, ownerAc } from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ApiConfig } from "../config.js";

const operatorRole = defaultAc.newRole({
  organization: ["update"],
  member: [],
  invitation: [],
  team: [],
  ac: ["read"],
});
const readOnlyRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ["read"],
});

export function createPayOpsAuth(
  config: ApiConfig,
  emailDelivery: EmailDeliveryPort,
) {
  const client = postgres(config.databaseUrl, {
    max: 10,
    onnotice: () => undefined,
  });
  const database = drizzle(client, { schema: betterAuthSchema });
  const auth = betterAuth({
    appName: "PayOps",
    baseURL: config.publicApiOrigin,
    basePath: "/api/auth",
    secrets: config.authSecrets.map((value, index, values) => ({
      version: values.length - index,
      value,
    })),
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: betterAuthSchema,
      usePlural: false,
      transaction: true,
    }),
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendAuthEmail(emailDelivery, {
          kind: "password_reset",
          to: user.email,
          actionUrl: url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail(emailDelivery, {
          kind: "email_verification",
          to: user.email,
          actionUrl: url,
        });
      },
    },
    session: {
      expiresIn: 12 * 60 * 60,
      updateAge: 60 * 60,
      freshAge: 15 * 60,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
        strategy: "jwe",
        refreshCache: false,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/request-password-reset": { window: 60 * 60, max: 5 },
      },
    },
    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
      cookiePrefix: "payops",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: config.environment === "production",
        sameSite: "lax",
        path: "/",
      },
      trustedProxyHeaders: false,
    },
    plugins: [
      organization({
        roles: {
          owner: ownerAc,
          operator: operatorRole,
          developer: readOnlyRole,
          accountant: readOnlyRole,
          viewer: readOnlyRole,
        },
        creatorRole: "owner",
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        membershipLimit: 50,
        invitationLimit: 100,
        invitationExpiresIn: 48 * 60 * 60,
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: async ({ id, email, organization: target }) => {
          const action = new URL("/accept-invitation", config.publicApiOrigin);
          action.searchParams.set("id", id);
          await sendAuthEmail(emailDelivery, {
            kind: "organization_invitation",
            to: email,
            actionUrl: action.toString(),
            organizationName: target.name,
          });
        },
      }),
      twoFactor({
        issuer: "PayOps",
        skipVerificationOnEnable: false,
        allowPasswordless: false,
        backupCodeOptions: {
          amount: 10,
          length: 12,
          storeBackupCodes: "encrypted",
        },
        accountLockout: {
          enabled: true,
          maxFailedAttempts: 10,
          durationSeconds: 15 * 60,
        },
      }),
      apiKey({
        configId: "payops-organization",
        references: "organization",
        apiKeyHeaders: "x-api-key",
        enableSessionForAPIKeys: false,
        disableKeyHashing: false,
        defaultPrefix: "payops_",
        defaultKeyLength: 64,
        requireName: true,
        enableMetadata: false,
        keyExpiration: {
          defaultExpiresIn: 90 * 24 * 60 * 60 * 1_000,
          disableCustomExpiresTime: false,
          minExpiresIn: 1,
          maxExpiresIn: 365,
        },
        rateLimit: {
          enabled: true,
          timeWindow: 60_000,
          maxRequests: 600,
        },
        permissions: {
          defaultPermissions: {
            payops: [
              "organizationRead",
              "walletRead",
              "customerRead",
              "invoiceRead",
            ],
          },
        },
      }),
    ],
  });

  return {
    auth,
    handler: async (request: Request): Promise<Response> => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        const origin = request.headers.get("origin");
        if (origin === null || !config.trustedOrigins.includes(origin)) {
          return Response.json(
            {
              code: "UNTRUSTED_ORIGIN",
              message: "Request origin is not trusted",
            },
            { status: 403 },
          );
        }
      }
      if (sensitiveAuthPath(new URL(request.url).pathname)) {
        const session = await auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true },
        });
        if (session === null) {
          return authPolicyResponse("fresh_authentication_required");
        }
        const age = Date.now() - session.session.createdAt.getTime();
        if (age < -30_000 || age > 15 * 60 * 1_000) {
          return authPolicyResponse("fresh_authentication_required");
        }
        if (session.user.twoFactorEnabled !== true) {
          return authPolicyResponse("two_factor_required");
        }
      }
      return auth.handler(request);
    },
    close: async () => client.end(),
  };
}

const sensitiveAuthPaths = new Set([
  "/api/auth/api-key/create",
  "/api/auth/api-key/update",
  "/api/auth/api-key/delete",
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/remove-member",
  "/api/auth/organization/update-member-role",
  "/api/auth/organization/create-role",
  "/api/auth/organization/update-role",
  "/api/auth/organization/delete-role",
]);

function sensitiveAuthPath(pathname: string): boolean {
  return sensitiveAuthPaths.has(pathname);
}

function authPolicyResponse(code: string): Response {
  return Response.json(
    { code, message: "Additional authentication is required" },
    { status: 403 },
  );
}

export async function hashAuthPassword(password: string): Promise<string> {
  return hashPassword(password);
}

async function sendAuthEmail(
  port: EmailDeliveryPort,
  message: AuthEmail,
): Promise<void> {
  await port.send(message);
}
