import { describe, expect, it } from "vitest";
import { permissionsForRole } from "@payops/platform";
import {
  requireSensitiveSession,
  type SessionActor,
} from "../src/auth/context.js";

const actor: SessionActor = {
  kind: "session",
  actorId: "user-1",
  organizationId: "00000000-0000-4000-8000-000000000001",
  role: "owner",
  permissions: permissionsForRole("owner"),
  sessionCreatedAt: new Date("2026-08-11T12:00:00.000Z"),
  twoFactorEnabled: false,
};

describe("sensitive authentication policy", () => {
  it("requires fresh user authentication and TOTP when requested", () => {
    expect(() =>
      requireSensitiveSession(actor, new Date("2026-08-11T12:01:00.000Z"), {
        requireTwoFactor: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "two_factor_required" }));

    expect(() =>
      requireSensitiveSession(
        { ...actor, twoFactorEnabled: true },
        new Date("2026-08-11T12:15:00.001Z"),
        { requireTwoFactor: true },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "fresh_authentication_required" }),
    );

    expect(
      requireSensitiveSession(
        { ...actor, twoFactorEnabled: true },
        new Date("2026-08-11T12:15:00.000Z"),
        { requireTwoFactor: true },
      ),
    ).toMatchObject({ actorId: "user-1" });
  });
});
