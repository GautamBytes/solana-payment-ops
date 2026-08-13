import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production-control migration authorization boundary", () => {
  it("preserves the released 4012 checksum and carries review fixes in 4013", async () => {
    const [migration4012, migration4013, bootstrap] = await Promise.all([
      readFile(
        new URL(
          "../migrations/4012_production_control_authority.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../migrations/4013_production_control_review_hardening.sql",
          import.meta.url,
        ),
        "utf8",
      ).catch(() => ""),
      readFile(
        new URL("../src/db/production-role-bootstrap.ts", import.meta.url),
        "utf8",
      ),
    ]);

    expect(
      createHash("sha256").update(migration4012, "utf8").digest("hex"),
    ).toBe("5106489a0337e8f765ea2554662e97bc3985549431686c270951622a0eb293c1");
    expect(bootstrap).toContain("payops_guard_reserved_audit_event");
    expect(migration4013).toContain("clock_timestamp() - interval '2 seconds'");
    expect(migration4013).toContain("procedure.proowner = namespace.nspowner");
    expect(migration4013).toContain("finalizer.proowner = namespace.nspowner");
    expect(bootstrap).toContain("pg_catalog.pg_trigger");
    expect(bootstrap).toContain("unexpected or invalid audit_events trigger");
    const auditLock = bootstrap.indexOf(
      "LOCK TABLE ${schema}.audit_events IN ACCESS EXCLUSIVE MODE",
    );
    expect(auditLock).toBeGreaterThan(-1);
    expect(auditLock).toBeLessThan(
      bootstrap.indexOf("FROM pg_catalog.pg_trigger AS audit_trigger"),
    );
  });

  it("uses security-definer capabilities instead of a caller-controlled setting", async () => {
    const [migration, hardening, store] = await Promise.all([
      readFile(
        new URL("../migrations/4011_production_controls.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../migrations/4012_production_control_authority.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../src/operations/production-control.ts", import.meta.url),
        "utf8",
      ),
    ]);

    expect(migration).not.toContain("payops.production_control_operation");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("payops_ensure_production_control");
    expect(migration).toContain("payops_promote_production_control");
    expect(migration).toContain("payops_record_shadow_projection_decision");
    expect(
      migration.match(/SET search_path = pg_catalog, %1\$I, pg_temp/g),
    ).toHaveLength(3);
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE[\s\S]+organization_production_controls/,
    );
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE[\s\S]+shadow_projection_decisions/,
    );
    expect(hardening).toContain("production_readiness_attestations");
    expect(hardening).toContain("payops_attest_production_readiness");
    expect(hardening).toContain("payops_request_production_promotion");
    expect(hardening).toContain("payops_finalize_production_control_authority");
    expect(hardening).toContain(
      "production role bootstrap is required before migration 4012",
    );
    expect(store).not.toContain("payops.production_control_operation");
    expect(store).not.toContain("FROM payops_promote_production_control(");
    expect(store).toContain("payops_attest_production_readiness(");
    expect(store).toContain("FROM payops_request_production_promotion(");
    expect(store).toContain("SELECT payops_record_shadow_projection_decision(");
    expect(store).not.toContain("SELECT payops_ensure_production_control(");
  });
});
