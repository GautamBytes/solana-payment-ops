import { describe, expect, it } from "vitest";
import {
  hasOrganizationPermission,
  ORGANIZATION_ROLES,
  permissionsForRole,
} from "../src/auth/permissions.js";

describe("organization permissions", () => {
  it("keeps roles static and least-privileged", () => {
    expect(ORGANIZATION_ROLES).toEqual([
      "owner",
      "operator",
      "developer",
      "accountant",
      "viewer",
    ]);
    expect(permissionsForRole("viewer")).toEqual({
      organizationRead: true,
      memberAdmin: false,
      apiKeyAdmin: false,
      walletRead: true,
      walletAdmin: false,
      customerRead: true,
      customerWrite: false,
      invoiceRead: true,
      invoiceWrite: false,
      invoiceIssue: false,
      paymentReview: false,
      accountingRead: false,
    });
    expect(hasOrganizationPermission("owner", "memberAdmin")).toBe(true);
    expect(hasOrganizationPermission("developer", "apiKeyAdmin")).toBe(false);
    expect(hasOrganizationPermission("accountant", "accountingRead")).toBe(
      true,
    );
    expect(permissionsForRole("accountant")).toMatchObject({
      customerWrite: false,
      invoiceWrite: false,
      invoiceIssue: false,
      paymentReview: true,
      accountingRead: true,
    });
  });

  it("fails closed for an unknown persisted role", () => {
    expect(() => permissionsForRole("admin")).toThrowError(
      expect.objectContaining({ code: "invalid_organization_role" }),
    );
  });
});
