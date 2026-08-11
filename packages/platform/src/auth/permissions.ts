export const ORGANIZATION_ROLES = [
  "owner",
  "operator",
  "developer",
  "accountant",
  "viewer",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export interface OrganizationPermissions {
  readonly organizationRead: boolean;
  readonly memberAdmin: boolean;
  readonly apiKeyAdmin: boolean;
  readonly walletRead: boolean;
  readonly walletAdmin: boolean;
  readonly customerRead: boolean;
  readonly customerWrite: boolean;
  readonly invoiceRead: boolean;
  readonly invoiceWrite: boolean;
  readonly invoiceIssue: boolean;
  readonly paymentReview: boolean;
  readonly accountingRead: boolean;
}

export type OrganizationPermission = keyof OrganizationPermissions;

export class AuthPolicyError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Organization authorization failed");
    this.name = "AuthPolicyError";
    this.code = code;
  }
}

const none: OrganizationPermissions = {
  organizationRead: false,
  memberAdmin: false,
  apiKeyAdmin: false,
  walletRead: false,
  walletAdmin: false,
  customerRead: false,
  customerWrite: false,
  invoiceRead: false,
  invoiceWrite: false,
  invoiceIssue: false,
  paymentReview: false,
  accountingRead: false,
};

const permissions = {
  owner: {
    organizationRead: true,
    memberAdmin: true,
    apiKeyAdmin: true,
    walletRead: true,
    walletAdmin: true,
    customerRead: true,
    customerWrite: true,
    invoiceRead: true,
    invoiceWrite: true,
    invoiceIssue: true,
    paymentReview: true,
    accountingRead: true,
  },
  operator: {
    ...none,
    organizationRead: true,
    walletRead: true,
    walletAdmin: true,
    customerRead: true,
    customerWrite: true,
    invoiceRead: true,
    invoiceWrite: true,
    invoiceIssue: true,
    paymentReview: true,
    accountingRead: true,
  },
  developer: {
    ...none,
    organizationRead: true,
    walletRead: true,
    customerRead: true,
    invoiceRead: true,
  },
  accountant: {
    ...none,
    organizationRead: true,
    walletRead: true,
    customerRead: true,
    invoiceRead: true,
    paymentReview: true,
    accountingRead: true,
  },
  viewer: {
    ...none,
    organizationRead: true,
    walletRead: true,
    customerRead: true,
    invoiceRead: true,
  },
} satisfies Record<OrganizationRole, OrganizationPermissions>;

export function permissionsForRole(role: string): OrganizationPermissions {
  if (!isOrganizationRole(role)) {
    throw new AuthPolicyError("invalid_organization_role");
  }
  return Object.freeze({ ...permissions[role] });
}

export function hasOrganizationPermission(
  role: string,
  permission: OrganizationPermission,
): boolean {
  return permissionsForRole(role)[permission];
}

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}
