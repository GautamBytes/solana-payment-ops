import type { IdempotencyResponseCommitter } from "@payops/platform";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { RequestActor, SessionActor } from "../src/auth/context.js";
import { errorBody } from "../src/protocol/api-error.js";
import { installRequestContext } from "../src/protocol/request-context.js";
import { registerOperationRoutes } from "../src/routes/operations.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const incidentId = "00000000-0000-4000-8000-000000000003";
const eventId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-08-14T00:00:00.000Z");

describe("authenticated operational routes", () => {
  it.each(["owner", "operator", "developer", "accountant", "viewer"] as const)(
    "allows the %s role to inspect canonical production and health state",
    async (role) => {
      const fixture = createFixture({ actor: sessionActor(role) });
      try {
        const production = await fixture.server.inject({
          method: "GET",
          url: "/v1/operations/production-control",
        });
        expect(production.statusCode).toBe(200);
        expect(production.headers["cache-control"]).toContain("no-store");
        expect(production.json()).toEqual({
          status: {
            activationMode: "shadow",
            version: 1,
            promotedAt: null,
            createdAt: "2026-08-12T00:00:00.000Z",
            updatedAt: "2026-08-12T00:00:00.000Z",
          },
          evaluation: {
            eligible: false,
            blockers: ["worker_heartbeat_stale"],
            prerequisites: {
              completeWatchCoverage: true,
              freshWorkerHeartbeat: false,
              twoActiveProductionRpcRoles: true,
              noOpenCriticalIncident: true,
            },
          },
          capabilities: {
            canManageIncidents: role === "owner" || role === "operator",
            canPromoteProduction: role === "owner",
          },
        });
        expect(production.body).not.toContain(organizationId);
        expect(production.body).not.toContain("owner-user");

        const health = await fixture.server.inject({
          method: "GET",
          url: "/v1/operations/health",
        });
        expect(health.statusCode).toBe(200);
        expect(health.headers["cache-control"]).toContain("no-store");
        expect(health.json()).toMatchObject({
          openWarningCount: 1,
          openCriticalCount: 0,
          measurements: [
            {
              kind: "worker_heartbeat_age_seconds",
              unit: "seconds",
              value: 45,
            },
          ],
        });
      } finally {
        await fixture.server.close();
      }
    },
  );

  it("enforces the organizationRead API-key scope and never permits API-key mutations", async () => {
    const allowed = createFixture({ actor: apiKeyActor(true) });
    const denied = createFixture({ actor: apiKeyActor(false) });
    try {
      const read = await allowed.server.inject({
        method: "GET",
        url: "/v1/operations/health",
      });
      expect(read.statusCode).toBe(200);
      const production = await allowed.server.inject({
        method: "GET",
        url: "/v1/operations/production-control",
      });
      expect(production.statusCode).toBe(200);
      expect(production.json()).toMatchObject({
        capabilities: {
          canManageIncidents: false,
          canPromoteProduction: false,
        },
      });
      const mutation = await allowed.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-incident-api-key-0001" },
        payload: { expectedVersion: 1 },
      });
      expect(mutation.statusCode).toBe(403);
      expect(mutation.json()).toMatchObject({
        code: "operator_session_required",
      });
      const forbidden = await denied.server.inject({
        method: "GET",
        url: "/v1/operations/health",
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ code: "forbidden" });
    } finally {
      await Promise.all([allowed.server.close(), denied.server.close()]);
    }
  });

  it("paginates incident lists and history with bound opaque cursors and redacted rows", async () => {
    const fixture = createFixture();
    try {
      const incidents = await fixture.server.inject({
        method: "GET",
        url: "/v1/operations/incidents?limit=1&state=open&kind=worker_stale",
      });
      expect(incidents.statusCode).toBe(200);
      expect(incidents.headers["cache-control"]).toContain("no-store");
      const incidentPage = incidents.json<{
        data: Record<string, unknown>[];
        nextCursor: string;
      }>();
      expect(incidentPage.data).toHaveLength(1);
      expect(incidentPage.data[0]).not.toHaveProperty("scopeKey");
      expect(incidentPage.data[0]).not.toHaveProperty("providerUrl");
      expect(incidents.body).not.toContain("provider-secret.example");
      expect(incidentPage.nextCursor.length).toBeGreaterThanOrEqual(16);

      const continued = await fixture.server.inject({
        method: "GET",
        url: `/v1/operations/incidents?limit=1&state=open&kind=worker_stale&cursor=${encodeURIComponent(incidentPage.nextCursor)}`,
      });
      expect(continued.statusCode).toBe(200);
      expect(fixture.incidentListInputs.at(-1)).toMatchObject({
        organizationId,
        state: "open",
        kind: "worker_stale",
        cursor: {
          lastObservedAt: "2026-08-13T23:55:00.000Z",
          id: incidentId,
        },
      });

      const history = await fixture.server.inject({
        method: "GET",
        url: `/v1/operations/incidents/${incidentId}/history?limit=1`,
      });
      const historyPage = history.json<{
        data: Record<string, unknown>[];
        nextCursor: string;
      }>();
      expect(history.statusCode).toBe(200);
      expect(historyPage.data[0]).not.toHaveProperty("actorId");
      expect(history.body).not.toContain("internal-actor-id");
      expect(historyPage.nextCursor.length).toBeGreaterThanOrEqual(16);
      const continuedHistory = await fixture.server.inject({
        method: "GET",
        url: `/v1/operations/incidents/${incidentId}/history?limit=1&cursor=${encodeURIComponent(historyPage.nextCursor)}`,
      });
      expect(continuedHistory.statusCode).toBe(200);
      expect(fixture.historyInputs.at(-1)).toMatchObject({
        organizationId,
        incidentId,
        cursor: { incidentVersion: 2, id: eventId },
      });
    } finally {
      await fixture.server.close();
    }
  });

  it("returns bounded protocol errors for malformed filters, cursors, identifiers, and dates", async () => {
    const fixture = createFixture();
    try {
      for (const url of [
        "/v1/operations/incidents?limit=0",
        "/v1/operations/incidents?state=active",
        "/v1/operations/incidents?kind=provider-secret",
        "/v1/operations/incidents?cursor=not-a-cursor",
        "/v1/operations/incidents?fromTime=not-a-date",
        `/v1/operations/incidents/${incidentId}/history?throughTime=2026-99-99`,
      ]) {
        const response = await fixture.server.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(400);
        expect(response.json(), url).toMatchObject({ code: "invalid_cursor" });
        expect(response.body, url).not.toContain("Error");
      }
      const absent = await fixture.server.inject({
        method: "GET",
        url: "/v1/operations/incidents/not-a-uuid/history",
      });
      expect(absent.statusCode).toBe(404);
      expect(absent.json()).toMatchObject({ code: "incident_not_found" });
    } finally {
      await fixture.server.close();
    }
  });

  it.each(["owner", "operator"] as const)(
    "allows an authenticated %s session to acknowledge and resolve incidents",
    async (role) => {
      const fixture = createFixture({ actor: sessionActor(role) });
      try {
        const acknowledged = await fixture.server.inject({
          method: "POST",
          url: `/v1/operations/incidents/${incidentId}/acknowledge`,
          headers: { "idempotency-key": `ack-${role}-incident-0001` },
          payload: { expectedVersion: 1 },
        });
        expect(acknowledged.statusCode).toBe(200);
        expect(acknowledged.json()).toMatchObject({
          id: incidentId,
          state: "acknowledged",
          version: 2,
        });
        expect(acknowledged.body).not.toContain("scopeKey");

        const resolved = await fixture.server.inject({
          method: "POST",
          url: `/v1/operations/incidents/${incidentId}/resolve`,
          headers: { "idempotency-key": `resolve-${role}-incident-0001` },
          payload: { expectedVersion: 2, resolutionCode: "operator_resolved" },
        });
        expect(resolved.statusCode).toBe(200);
        expect(resolved.json()).toMatchObject({
          state: "resolved",
          version: 3,
          resolutionCode: "operator_resolved",
        });
      } finally {
        await fixture.server.close();
      }
    },
  );

  it.each(["developer", "accountant", "viewer"] as const)(
    "denies incident mutations to the %s role",
    async (role) => {
      const fixture = createFixture({ actor: sessionActor(role) });
      try {
        const response = await fixture.server.inject({
          method: "POST",
          url: `/v1/operations/incidents/${incidentId}/acknowledge`,
          headers: { "idempotency-key": `ack-${role}-incident-0001` },
          payload: { expectedVersion: 1 },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: "operator_session_required",
        });
      } finally {
        await fixture.server.close();
      }
    },
  );

  it("rejects unknown mutation keys, stale versions, and conflicting idempotency requests", async () => {
    const fixture = createFixture();
    try {
      const unknown = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-incident-unknown-key" },
        payload: { expectedVersion: 1, note: "leak this" },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({ code: "invalid_request" });

      const stale = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-incident-stale-0001" },
        payload: { expectedVersion: 99 },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "incident_version_conflict" });

      const first = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-incident-replay-0001" },
        payload: { expectedVersion: 1 },
      });
      const repeated = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-incident-replay-0001" },
        payload: { expectedVersion: 1 },
      });
      const conflict = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-incident-replay-0001" },
        payload: { expectedVersion: 2 },
      });
      expect(first.statusCode).toBe(200);
      expect(repeated.statusCode).toBe(200);
      expect(repeated.body).toBe(first.body);
      expect(fixture.acknowledgeCalls).toBe(2);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "idempotency_conflict" });
    } finally {
      await fixture.server.close();
    }
  });

  it("keeps cross-tenant guessed incidents indistinguishable from absent resources", async () => {
    const fixture = createFixture({ hideIncidents: true });
    try {
      const history = await fixture.server.inject({
        method: "GET",
        url: `/v1/operations/incidents/${incidentId}/history`,
      });
      const mutation = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "cross-tenant-incident-0001" },
        payload: { expectedVersion: 1 },
      });
      expect(history.statusCode).toBe(404);
      expect(mutation.statusCode).toBe(404);
      expect(history.json()).toMatchObject({ code: "incident_not_found" });
      expect(mutation.json()).toMatchObject({ code: "incident_not_found" });
      expect(fixture.historyInputs[0]).toMatchObject({ organizationId });
      expect(fixture.acknowledgeInputs[0]).toMatchObject({ organizationId });
      expect(fixture.historyInputs[0]).not.toMatchObject({
        organizationId: otherOrganizationId,
      });
    } finally {
      await fixture.server.close();
    }
  });

  it("requires explicit confirmation and a fresh two-factor owner session for promotion", async () => {
    const staleOwner = createFixture({
      actor: {
        ...sessionActor("owner"),
        sessionCreatedAt: new Date("2026-08-13T00:00:00.000Z"),
      },
    });
    const operator = createFixture({ actor: sessionActor("operator") });
    const owner = createFixture();
    try {
      const staleView = await staleOwner.server.inject({
        method: "GET",
        url: "/v1/operations/production-control",
      });
      expect(staleView.json()).toMatchObject({
        capabilities: {
          canManageIncidents: true,
          canPromoteProduction: false,
        },
      });

      const unconfirmed = await owner.server.inject({
        method: "POST",
        url: "/v1/operations/production-control/promote",
        headers: { "idempotency-key": "promote-unconfirmed-0001" },
        payload: { confirmed: false, expectedVersion: 1 },
      });
      expect(unconfirmed.statusCode).toBe(400);
      expect(owner.promoteCalls).toBe(0);

      const stale = await staleOwner.server.inject({
        method: "POST",
        url: "/v1/operations/production-control/promote",
        headers: { "idempotency-key": "promote-stale-owner-0001" },
        payload: { confirmed: true, expectedVersion: 1 },
      });
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({
        code: "fresh_owner_session_required",
      });

      const notOwner = await operator.server.inject({
        method: "POST",
        url: "/v1/operations/production-control/promote",
        headers: { "idempotency-key": "promote-not-owner-0001" },
        payload: { confirmed: true, expectedVersion: 1 },
      });
      expect(notOwner.statusCode).toBe(403);
      expect(notOwner.json()).toMatchObject({ code: "owner_session_required" });

      const promoted = await owner.server.inject({
        method: "POST",
        url: "/v1/operations/production-control/promote",
        headers: { "idempotency-key": "promote-fresh-owner-0001" },
        payload: { confirmed: true, expectedVersion: 1 },
      });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toMatchObject({
        outcome: "promoted",
        status: { activationMode: "live", version: 2 },
      });
      expect(owner.promoteCalls).toBe(1);
    } finally {
      await Promise.all([
        staleOwner.server.close(),
        operator.server.close(),
        owner.server.close(),
      ]);
    }
  });

  it("returns the canonical promotion race result when a new critical fact blocks live mode", async () => {
    const fixture = createFixture({ promotionBlocked: true });
    try {
      const response = await fixture.server.inject({
        method: "POST",
        url: "/v1/operations/production-control/promote",
        headers: { "idempotency-key": "promote-critical-race-0001" },
        payload: { confirmed: true, expectedVersion: 1 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        outcome: "blocked",
        status: { activationMode: "shadow", version: 1 },
        evaluation: {
          eligible: false,
          blockers: ["open_critical_incident"],
        },
      });
    } finally {
      await fixture.server.close();
    }
  });

  it("maps unavailable mutation authorities to a bounded degraded response", async () => {
    const fixture = createFixture({ healthUnavailable: true });
    try {
      const response = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-incident-unavailable-01" },
        payload: { expectedVersion: 1 },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "operations_unavailable",
        message: "Operational state is unavailable",
      });
      expect(response.body).not.toContain("hidden authority failure");
    } finally {
      await fixture.server.close();
    }
  });

  it("does not permanently complete transient unavailable responses", async () => {
    const fixture = createFixture({ healthUnavailableOnce: true });
    try {
      const request = {
        method: "POST" as const,
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-transient-unavailable-0001" },
        payload: { expectedVersion: 1 },
      };
      const unavailable = await fixture.server.inject(request);
      const retried = await fixture.server.inject(request);

      expect(unavailable.statusCode).toBe(503);
      expect(retried.statusCode).toBe(200);
      expect(fixture.acknowledgeCalls).toBe(2);
      expect(fixture.idempotency.operationResults[0]).toMatchObject({
        idempotencyRetryable: true,
      });
    } finally {
      await fixture.server.close();
    }
  });

  it("passes exact atomic response contracts to incident and promotion stores", async () => {
    const fixture = createFixture();
    try {
      const acknowledged = await fixture.server.inject({
        method: "POST",
        url: `/v1/operations/incidents/${incidentId}/acknowledge`,
        headers: { "idempotency-key": "ack-atomic-contract-0001" },
        payload: { expectedVersion: 1 },
      });
      const promoted = await fixture.server.inject({
        method: "POST",
        url: "/v1/operations/production-control/promote",
        headers: { "idempotency-key": "promote-atomic-contract-0001" },
        payload: { confirmed: true, expectedVersion: 1 },
      });

      expect(acknowledged.statusCode).toBe(200);
      expect(promoted.statusCode).toBe(200);
      expect(fixture.acknowledgeInputs[0]).toHaveProperty("idempotency");
      expect(fixture.promoteInputs[0]).toHaveProperty("idempotency");
      expect(fixture.idempotency.operationResults).toEqual([
        expect.objectContaining({ idempotencyCompleted: true }),
        expect.objectContaining({ idempotencyCompleted: true }),
      ]);
      expect(fixture.idempotency.atomicCompletions).toEqual([
        { status: 200, body: acknowledged.json() },
        { status: 200, body: promoted.json() },
      ]);
    } finally {
      await fixture.server.close();
    }
  });
});

function createFixture(
  options: {
    readonly actor?: RequestActor;
    readonly hideIncidents?: boolean;
    readonly promotionBlocked?: boolean;
    readonly healthUnavailable?: boolean;
    readonly healthUnavailableOnce?: boolean;
  } = {},
) {
  const server = Fastify();
  installRequestContext(server);
  const incidentListInputs: Record<string, unknown>[] = [];
  const historyInputs: Record<string, unknown>[] = [];
  const acknowledgeInputs: Record<string, unknown>[] = [];
  const promoteInputs: Record<string, unknown>[] = [];
  let acknowledgeCalls = 0;
  let promoteCalls = 0;
  let healthUnavailableRemaining = options.healthUnavailableOnce ? 1 : 0;
  const idempotency = new TestIdempotency();
  const dependencies = {
    auth: {
      resolve: async () => options.actor ?? sessionActor("owner"),
      close: async () => undefined,
    },
    rateLimits: {
      consume: async () => ({
        allowed: true,
        limit: 600,
        remaining: 599,
        retryAfterSeconds: 0,
      }),
    },
    idempotency,
    exceptions: {
      list: async () => [],
      history: async () => [],
      assign: async () => paymentException(),
      startInvestigation: async () => paymentException(),
      escalate: async () => paymentException(),
      reopen: async () => paymentException(),
      resolve: async () => paymentException(),
    },
    exports: {
      generate: async () => accountingExport(),
      get: async () => null,
    },
    productionControls: {
      getStatus: async () => productionStatus("shadow", 1),
      evaluatePromotion: async () => evaluation("worker_heartbeat_stale"),
      promoteLive: async (input: Record<string, unknown>) => {
        promoteInputs.push(input);
        promoteCalls += 1;
        const result = options.promotionBlocked
          ? {
              outcome: "blocked" as const,
              status: productionStatus("shadow", 1),
              evaluation: evaluation("open_critical_incident"),
            }
          : {
              outcome: "promoted" as const,
              status: productionStatus("live", 2),
            };
        await completeMockIdempotency(input, result);
        return result;
      },
    },
    operationalHealth: {
      getSnapshot: async () => ({
        measurements: [
          {
            kind: "worker_heartbeat_age_seconds" as const,
            unit: "seconds" as const,
            windowSeconds: 300 as const,
            bucketStart: "2026-08-13T23:55:00.000Z",
            value: 45,
            sampleCount: 1,
            generatedAt: "2026-08-14T00:00:00.000Z",
          },
        ],
        openWarningCount: 1,
        openCriticalCount: 0,
        generatedAt: "2026-08-14T00:00:00.000Z",
      }),
      listIncidents: async (input: Record<string, unknown>) => {
        incidentListInputs.push(input);
        return {
          items: [incident("open", 1)],
          nextCursor:
            input.cursor === undefined
              ? {
                  lastObservedAt: "2026-08-13T23:55:00.000Z",
                  id: incidentId,
                }
              : null,
        };
      },
      listIncidentHistory: async (input: Record<string, unknown>) => {
        historyInputs.push(input);
        if (options.hideIncidents) throw coded("incident_not_found");
        return {
          items: [incidentEvent()],
          nextCursor:
            input.cursor === undefined
              ? { incidentVersion: 2, id: eventId }
              : null,
        };
      },
      acknowledgeIncident: async (input: Record<string, unknown>) => {
        acknowledgeInputs.push(input);
        acknowledgeCalls += 1;
        if (options.healthUnavailable || healthUnavailableRemaining-- > 0)
          throw coded("operational_health_unavailable");
        if (options.hideIncidents) throw coded("incident_not_found");
        if (input.expectedVersion === 99)
          throw coded("incident_version_conflict");
        const result = incident("acknowledged", 2);
        await completeMockIdempotency(input, result);
        return result;
      },
      resolveIncident: async (input: Record<string, unknown>) => {
        const result = incident("resolved", 3);
        await completeMockIdempotency(input, result);
        return result;
      },
    },
  };
  registerOperationRoutes(server, dependencies);
  return {
    server,
    incidentListInputs,
    historyInputs,
    acknowledgeInputs,
    promoteInputs,
    idempotency,
    get acknowledgeCalls() {
      return acknowledgeCalls;
    },
    get promoteCalls() {
      return promoteCalls;
    },
  };
}

async function completeMockIdempotency(
  input: Record<string, unknown>,
  result: unknown,
): Promise<void> {
  const value = input.idempotency;
  if (value === null || typeof value !== "object") return;
  const idempotency = value as {
    readonly committer: IdempotencyResponseCommitter;
    readonly status?: number;
    readonly responseBody?: (result: never) => unknown;
    readonly response?: (result: never) => {
      readonly status: number;
      readonly body: unknown;
    };
  };
  const response =
    idempotency.response === undefined
      ? {
          status: idempotency.status ?? 200,
          body: idempotency.responseBody?.(result as never),
        }
      : idempotency.response(result as never);
  await idempotency.committer.complete(
    {} as Parameters<IdempotencyResponseCommitter["complete"]>[0],
    response.status,
    response.body,
  );
}

class TestIdempotency {
  readonly #records = new Map<
    string,
    { readonly digest: string; readonly status: number; readonly body: unknown }
  >();
  public readonly operationResults: Record<string, unknown>[] = [];
  public readonly atomicCompletions: {
    readonly status: number;
    readonly body: unknown;
  }[] = [];

  public async execute(
    request: FastifyRequest,
    reply: FastifyReply,
    actor: RequestActor,
    routeId: string,
    path: Readonly<Record<string, string>>,
    body: unknown,
    operation: (_committer: IdempotencyResponseCommitter) => Promise<{
      readonly status: number;
      readonly body: unknown;
      readonly idempotencyCompleted?: true;
      readonly idempotencyRetryable?: true;
    }>,
  ) {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 16) {
      return reply
        .code(400)
        .send(
          errorBody(
            request,
            "invalid_idempotency_key",
            "A valid Idempotency-Key is required",
          ),
        );
    }
    const identity = `${actor.organizationId}:${actor.actorId}:${routeId}:${key}`;
    const digest = JSON.stringify({ path, body });
    const existing = this.#records.get(identity);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        return reply
          .code(409)
          .send(
            errorBody(
              request,
              "idempotency_conflict",
              "Idempotency key was already used for another request",
            ),
          );
      }
      return reply.code(existing.status).send(existing.body);
    }
    let atomicCompletion:
      { readonly status: number; readonly body: unknown } | undefined;
    const result = await operation({
      complete: async (_transaction, status, completedBody) => {
        atomicCompletion = { status, body: completedBody };
        this.atomicCompletions.push(atomicCompletion);
      },
    });
    this.operationResults.push(result);
    if (result.idempotencyCompleted === true) {
      if (atomicCompletion === undefined)
        throw new Error("atomic completion was not recorded");
      this.#records.set(identity, { digest, ...atomicCompletion });
    } else if (result.idempotencyRetryable !== true) {
      this.#records.set(identity, { digest, ...result });
    }
    return reply.code(result.status).send(result.body);
  }
}

function sessionActor(role: SessionActor["role"]): SessionActor {
  return {
    kind: "session",
    actorId: `${role}-user`,
    organizationId,
    role,
    permissions: {
      organizationRead: true,
      memberAdmin: role === "owner",
      apiKeyAdmin: role === "owner",
      walletRead: true,
      walletAdmin: role === "owner" || role === "operator",
      customerRead: true,
      customerWrite: role === "owner" || role === "operator",
      invoiceRead: true,
      invoiceWrite: role === "owner" || role === "operator",
      invoiceIssue: role === "owner" || role === "operator",
      paymentReview: ["owner", "operator", "accountant"].includes(role),
      accountingRead: ["owner", "operator", "accountant"].includes(role),
    },
    sessionCreatedAt: new Date(),
    twoFactorEnabled: true,
  };
}

function apiKeyActor(organizationRead: boolean): RequestActor {
  return {
    kind: "api_key",
    actorId: "operations-api-key",
    organizationId,
    permissions: {
      organizationRead,
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
    },
  };
}

function productionStatus(activationMode: "shadow" | "live", version: number) {
  return {
    organizationId,
    activationMode,
    version,
    promotedAt: activationMode === "live" ? "2026-08-14T00:00:00.000Z" : null,
    promotedBy: activationMode === "live" ? "owner-user" : null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt:
      activationMode === "live"
        ? "2026-08-14T00:00:00.000Z"
        : "2026-08-12T00:00:00.000Z",
  } as const;
}

function evaluation(
  blocker: "worker_heartbeat_stale" | "open_critical_incident",
) {
  return {
    eligible: false,
    blockers: [blocker],
    prerequisites: {
      completeWatchCoverage: true,
      freshWorkerHeartbeat: blocker !== "worker_heartbeat_stale",
      twoActiveProductionRpcRoles: true,
      noOpenCriticalIncident: blocker !== "open_critical_incident",
    },
  } as const;
}

function incident(
  state: "open" | "acknowledged" | "resolved",
  version: number,
) {
  return {
    id: incidentId,
    kind: "worker_stale" as const,
    severity: "warning" as const,
    scopeKey: "a".repeat(64),
    state,
    version,
    firstObservedAt: "2026-08-13T23:50:00.000Z",
    lastObservedAt: "2026-08-13T23:55:00.000Z",
    occurrenceCount: 3,
    acknowledgedAt: state === "open" ? null : "2026-08-13T23:56:00.000Z",
    acknowledgedActorKind: state === "open" ? null : ("session" as const),
    resolvedAt: state === "resolved" ? "2026-08-13T23:57:00.000Z" : null,
    resolvedActorKind: state === "resolved" ? ("session" as const) : null,
    resolutionCode:
      state === "resolved" ? ("operator_resolved" as const) : null,
    createdAt: "2026-08-13T23:50:00.000Z",
    updatedAt: "2026-08-13T23:55:00.000Z",
    providerUrl: "https://provider-secret.example",
  };
}

function incidentEvent() {
  return {
    id: eventId,
    incidentId,
    incidentVersion: 2,
    action: "acknowledged" as const,
    fromState: "open" as const,
    toState: "acknowledged" as const,
    occurrenceCount: 3,
    actorKind: "session" as const,
    occurredAt: "2026-08-13T23:56:00.000Z",
    createdAt: "2026-08-13T23:56:00.000Z",
    actorId: "internal-actor-id",
  };
}

function coded(code: string): Error & { readonly code: string } {
  return Object.assign(new Error("hidden authority failure"), { code });
}

function paymentException() {
  return {
    id: incidentId,
    invoiceId: null,
    attemptId: eventId,
    eventId: "event",
    signature: "1".repeat(64),
    amountBaseUnits: "1",
    assetSymbol: "USDC" as const,
    mint: "11111111111111111111111111111111",
    decimals: 6,
    ruleCode: "test",
    ruleVersion: "1",
    reviewState: "open" as const,
    assignedTo: null,
    resolutionCode: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    version: 1,
    createdAt: now.toISOString(),
  };
}

function accountingExport() {
  return {
    id: eventId,
    format: "payments_csv" as const,
    fromTime: now.toISOString(),
    throughTime: now.toISOString(),
    contentBytes: new Uint8Array(),
    contentDigest: "a".repeat(64),
    rowCount: 0,
    generatedAt: now.toISOString(),
  };
}
