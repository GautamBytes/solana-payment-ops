import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PLATFORM_MIGRATION_NAMES } from "../src/index.js";

describe("operational-health migration boundary", () => {
  it("registers an additive guarded workflow with transactional producers", async () => {
    const migration = await readFile(
      new URL("../migrations/4015_operational_health.sql", import.meta.url),
      "utf8",
    );

    expect(PLATFORM_MIGRATION_NAMES).toContain("4015_operational_health");
    for (const table of [
      "operational_measurements",
      "operational_incidents",
      "operational_incident_events",
      "operational_health_signals",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    for (const workflow of [
      "payops_record_operational_measurement",
      "payops_observe_operational_incident",
      "payops_acknowledge_operational_incident",
      "payops_resolve_operational_incident",
      "payops_operational_health_clear_for_promotion",
      "payops_process_operational_health_signals",
      "payops_enqueue_scheduled_operational_health_signals",
    ]) {
      expect(migration).toContain(workflow);
    }
    expect(migration).toContain(":operational-health-authority");
    expect(migration).toContain("rpc_consensus_checks_health_signal");
    expect(migration).toContain("webhook_delivery_attempts_health_signal");
    expect(migration).toContain("ledger_reconciliations_health_signal");
    expect(migration).toContain("incident_version DESC, id DESC");
    expect(migration).toContain("last_observed_at DESC, id DESC");
  });

  it("places health authority behind the production capability boundary", async () => {
    const bootstrap = await readFile(
      new URL("../src/db/production-role-bootstrap.ts", import.meta.url),
      "utf8",
    );

    for (const table of [
      "operational_measurements",
      "operational_incidents",
      "operational_incident_events",
      "operational_health_signals",
    ]) {
      expect(bootstrap).toContain(`ALTER TABLE \${schema}.${table} OWNER TO`);
    }
    expect(bootstrap).toContain(
      "payops_process_operational_health_signals(uuid, integer, timestamptz)",
    );
    expect(bootstrap).toContain(
      "payops_enqueue_scheduled_operational_health_signals(uuid, timestamptz, text, text, text, text, text, text, text, text)",
    );
    expect(bootstrap).toContain(
      `GRANT SELECT ON \${schema}.operational_measurements,
          \${schema}.operational_incidents,
          \${schema}.operational_incident_events TO \${runtime}`,
    );
  });

  it("serializes persisted promotion evaluation on the health authority lock", async () => {
    const source = await readFile(
      new URL("../src/operations/production-control.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("acquireOperationalHealthAuthorityLock");
    expect(source).toContain("payops_operational_health_clear_for_promotion");
    expect(source).not.toContain("FROM operational_health_signals AS signal");
  });
});
