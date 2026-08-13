import type { OrganizationDatabase } from "../src/index.js";
import { describe, expect, it } from "vitest";
import { OperationalHealthStore } from "../src/index.js";

const unavailableDatabase = {
  transaction(): never {
    throw new Error("database must not be reached");
  },
} as unknown as OrganizationDatabase;

describe("operational health input boundary", () => {
  const store = new OperationalHealthStore(unavailableDatabase);

  it("rejects source identities instead of accepting unbounded scope data", async () => {
    await expect(
      store.observeIncident({
        organizationId: "00000000-0000-4000-8000-000000000001",
        actorId: "worker",
        actorKind: "system",
        kind: "rpc_disagreement",
        severity: "critical",
        scopeKey: "https://rpc.example.invalid/secret",
        observedAt: new Date("2026-08-13T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_operational_health_input" });
  });

  it("bounds page sizes and validates stable cursors before querying", async () => {
    await expect(
      store.listIncidents({
        organizationId: "00000000-0000-4000-8000-000000000001",
        actorId: "operator",
        limit: 101,
      }),
    ).rejects.toMatchObject({ code: "invalid_operational_health_input" });
    await expect(
      store.listIncidentHistory({
        organizationId: "00000000-0000-4000-8000-000000000001",
        actorId: "operator",
        incidentId: "00000000-0000-4000-8000-000000000002",
        cursor: {
          incidentVersion: 0,
          id: "00000000-0000-4000-8000-000000000003",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_operational_health_input" });
  });

  it("fails closed on runtime-malformed dates and cursors", async () => {
    await expect(
      store.recordMeasurement({
        organizationId: "00000000-0000-4000-8000-000000000001",
        actorId: "worker",
        kind: "rpc_consensus_checks",
        value: 1,
        generatedAt: {} as Date,
      }),
    ).rejects.toMatchObject({ code: "invalid_operational_health_input" });
    await expect(
      store.listIncidents({
        organizationId: "00000000-0000-4000-8000-000000000001",
        actorId: "operator",
        cursor: null as unknown as {
          lastObservedAt: string;
          id: string;
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_operational_health_input" });
    await expect(
      store.enqueueScheduledSignals({
        organizationId: "00000000-0000-4000-8000-000000000001",
        actorId: "worker",
        observedAt: new Date("2026-08-13T12:00:00.000Z"),
        rpc: null as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_operational_health_input" });
  });
});
