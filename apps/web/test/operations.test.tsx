import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationsDashboard } from "../components/operations-dashboard";
import {
  createAccountingExport,
  createEvidencePack,
  listPaymentExceptions,
  type PaymentException,
} from "../lib/operations-api";
import * as operationsApi from "../lib/operations-api";
import { checkoutSecurityHeaders } from "../lib/security-headers";
import { payopsCookieHeader } from "../lib/auth-cookie";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const INVOICE_ID = "123e4567-e89b-42d3-a456-426614174001";
const EXCEPTION_ID = "123e4567-e89b-42d3-a456-426614174002";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("merchant operations", () => {
  it("forwards local and production secure PayOps cookies only", () => {
    expect(
      payopsCookieHeader([
        { name: "payops.session_token", value: "local" },
        { name: "__Secure-payops.session_token", value: "production" },
        { name: "payops.session_data", value: "local-cache" },
        { name: "__Secure-payops.account_data", value: "account-cache" },
        { name: "payops.attacker_controlled", value: "attacker" },
        { name: "__Secure-other.session_token", value: "secret" },
      ]),
    ).toBe(
      "payops.session_token=local; __Secure-payops.session_token=production",
    );
  });

  it("fetches a bounded exception page while forwarding only the session cookie", async () => {
    vi.stubEnv("PAYOPS_API_ORIGIN", "https://api.example.com");
    vi.stubEnv("PAYOPS_WEB_ORIGIN", "https://app.example.com");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        { data: [exceptionFixture()], nextCursor: null },
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const page = await listPaymentExceptions("payops.session_token=safe", {
      state: "open",
      limit: 50,
    });

    expect(page.data).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.com/v1/exceptions?limit=50&state=open",
    );
    expect(new Headers(init?.headers).get("cookie")).toBe(
      "payops.session_token=safe",
    );
    expect(init?.redirect).toBe("error");
  });

  it("forwards the trusted origin and reuses each browser operation key", async () => {
    vi.stubEnv("PAYOPS_API_ORIGIN", "https://api.example.com");
    vi.stubEnv("PAYOPS_WEB_ORIGIN", "https://app.example.com");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: EXCEPTION_ID, invoiceId: INVOICE_ID }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: EXCEPTION_ID, format: "quickbooks_csv" }),
      );
    vi.stubGlobal("fetch", fetch);

    await createEvidencePack("cookie", INVOICE_ID, REQUEST_ID);
    await createAccountingExport("cookie", {
      format: "quickbooks_csv",
      fromTime: "2026-08-01T00:00:00.000Z",
      throughTime: "2026-08-12T00:00:00.000Z",
      idempotencyKey: EXCEPTION_ID,
    });

    const first = new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
      "idempotency-key",
    );
    const second = new Headers(fetch.mock.calls[1]?.[1]?.headers).get(
      "idempotency-key",
    );
    expect(first).toBe(REQUEST_ID);
    expect(second).toBe(EXCEPTION_ID);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("origin")).toBe(
      "https://app.example.com",
    );
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("origin")).toBe(
      "https://app.example.com",
    );
  });

  it("renders a real exception work queue and audit-oriented actions", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [exceptionFixture()],
        now: new Date("2026-08-12T12:00:00.000Z"),
      }),
    );

    expect(markup).toContain("Payment operations");
    expect(markup).toContain("needs review");
    expect(markup).toContain("Wrong amount");
    expect(markup).toContain("125.500000 USDT");
    expect(markup).toContain("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(markup).toContain("Token decimals");
    expect(markup).toContain(">6</dd>");
    expect(markup).toContain("Assign case");
    expect(markup).toContain("Generate signed evidence");
    expect(markup).toContain("QuickBooks-ready CSV");
    expect(markup.match(/name="idempotencyKey"/gu)).toHaveLength(4);
  });

  it("fetches canonical production, health, incident, and history views", async () => {
    expect(operationsApi).toMatchObject({
      getProductionControl: expect.any(Function),
      getOperationalHealth: expect.any(Function),
      listOperationalIncidents: expect.any(Function),
      getOperationalIncidentHistory: expect.any(Function),
    });
    vi.stubEnv("PAYOPS_API_ORIGIN", "https://api.example.com");
    vi.stubEnv("PAYOPS_WEB_ORIGIN", "https://app.example.com");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(productionFixture()))
      .mockResolvedValueOnce(Response.json(healthFixture()))
      .mockResolvedValueOnce(
        Response.json({ data: [incidentFixture()], nextCursor: null }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [historyFixture()], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetch);

    await operationsApi.getProductionControl("payops.session_token=safe");
    await operationsApi.getOperationalHealth("payops.session_token=safe");
    await operationsApi.listOperationalIncidents("payops.session_token=safe", {
      limit: 20,
      state: "open",
    });
    await operationsApi.getOperationalIncidentHistory(
      "payops.session_token=safe",
      EXCEPTION_ID,
      { limit: 10 },
    );

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.com/v1/operations/production-control",
      "https://api.example.com/v1/operations/health",
      "https://api.example.com/v1/operations/incidents?limit=20&state=open",
      `https://api.example.com/v1/operations/incidents/${EXCEPTION_ID}/history?limit=10`,
    ]);
  });

  it("renders the authority rail, stale health, incident actions, history, and conflict feedback", () => {
    const props = {
      exceptions: [exceptionFixture()],
      production: productionFixture(),
      health: healthFixture(),
      incidents: [incidentFixture()],
      incidentHistory: [historyFixture()],
      notice: {
        tone: "conflict" as const,
        message:
          "The incident changed. Review the latest version and try again.",
      },
      now: new Date("2026-08-12T12:10:00.000Z"),
    };
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, props),
    );

    expect(markup).toContain("Production authority");
    expect(markup).toContain("Shadow");
    expect(markup).toContain("Consensus healthy");
    expect(markup).toContain("Live");
    expect(markup).toContain("Worker heartbeat stale");
    expect(markup).toContain("Restore a fresh worker heartbeat");
    expect(markup).toContain("Measurements stale");
    expect(markup).toContain("45 seconds");
    expect(markup).toContain("Worker stale");
    expect(markup).toContain("3 occurrences");
    expect(markup).toContain("Acknowledge incident");
    expect(markup).toContain("Resolve incident");
    expect(markup).toContain("Incident history");
    expect(markup).toContain("Acknowledged");
    expect(markup).toContain("The incident changed");
    expect(markup).not.toContain("scopeKey");
    expect(markup).not.toContain("a".repeat(64));
  });

  it("requires explicit promotion confirmation and marks current measurements fresh", () => {
    const props = {
      exceptions: [],
      production: productionFixture(),
      health: healthFixture(),
      incidents: [],
      incidentHistory: [],
      now: new Date("2026-08-12T12:04:00.000Z"),
    };
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, props),
    );
    expect(markup).toContain("Measurements fresh");
    expect(markup).toMatch(
      /type="checkbox"[^>]*required=""[^>]*name="confirmed"[^>]*value="true"/u,
    );
    expect(markup).toContain("Promote to live");
  });

  it("derives health freshness from every persisted measurement", () => {
    const now = new Date("2026-08-12T12:00:00.000Z");
    const snapshotGeneratedAt = now.toISOString();
    const renderFreshness = (health: ReturnType<typeof healthFixture>) =>
      renderToStaticMarkup(
        createElement(OperationsDashboard, {
          exceptions: [],
          production: productionFixture(),
          health,
          incidents: [],
          incidentHistory: [],
          now,
        }),
      );

    expect(
      renderFreshness(
        healthFixture({
          measurementGeneratedAt: "2026-08-12T11:00:00.000Z",
          snapshotGeneratedAt,
        }),
      ),
    ).toContain("Measurements stale");
    expect(
      renderFreshness(
        healthFixture({
          measurementGeneratedAt: "2026-08-12T12:01:00.000Z",
          snapshotGeneratedAt,
        }),
      ),
    ).toContain("Measurements stale");
    expect(
      renderFreshness(
        healthFixture({
          snapshotGeneratedAt,
          omitKind: "ledger_mismatches",
        }),
      ),
    ).toContain("Measurements degraded");
    expect(renderFreshness(healthFixture({ snapshotGeneratedAt }))).toContain(
      "Measurements fresh",
    );
  });

  it.each(["viewer", "developer"])(
    "renders operational authority for a %s without unauthorized controls",
    () => {
      const markup = renderToStaticMarkup(
        createElement(OperationsDashboard, {
          exceptions: [],
          exceptionState: "unauthorized",
          production: productionFixture({
            canManageIncidents: false,
            canPromoteProduction: false,
          }),
          health: healthFixture(),
          incidents: [incidentFixture()],
          incidentHistory: [historyFixture()],
          now: new Date("2026-08-12T12:00:00.000Z"),
          actions: operationsActions(),
        }),
      );

      expect(markup).toContain("Production authority");
      expect(markup).toContain("Exception queue is unavailable for this role");
      expect(markup).not.toContain("Acknowledge incident");
      expect(markup).not.toContain("Resolve incident");
      expect(markup).not.toContain("Promote to live");
      expect(markup).not.toContain("Generate signed evidence");
    },
  );

  it("keeps authority visible when exception loading is unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [],
        exceptionState: "unavailable",
        production: productionFixture(),
        health: healthFixture(),
        incidents: [],
        incidentHistory: [],
        now: new Date("2026-08-12T12:00:00.000Z"),
        actions: operationsActions(),
      }),
    );

    expect(markup).toContain("Activation mode: Shadow");
    expect(markup).toContain("Measurements fresh");
    expect(markup).toContain("Exception queue is temporarily unavailable");
    expect(markup).not.toContain("Queue clear");
  });

  it("keeps health and incidents visible when authority loading fails", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [],
        authorityState: "unavailable",
        health: healthFixture(),
        incidents: [incidentFixture()],
        incidentHistory: [historyFixture()],
        now: new Date("2026-08-12T12:00:00.000Z"),
      }),
    );

    expect(markup).toContain("Authority is temporarily unavailable");
    expect(markup).toContain("Measurements fresh");
    expect(markup).toContain("Worker stale");
    expect(markup).toContain("Incident history");
  });

  it("keeps the incident queue visible when history loading fails", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [],
        production: productionFixture(),
        health: healthFixture(),
        incidents: [incidentFixture()],
        historyState: "unavailable",
        now: new Date("2026-08-12T12:00:00.000Z"),
      }),
    );

    expect(markup).toContain("Worker stale");
    expect(markup).toContain("Incident history is temporarily unavailable");
    expect(markup).not.toContain(
      "No history is available for the newest incident",
    );
  });

  it("shows incident actions to operators without exposing owner promotion", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [exceptionFixture()],
        production: productionFixture({
          canManageIncidents: true,
          canPromoteProduction: false,
        }),
        health: healthFixture(),
        incidents: [incidentFixture()],
        incidentHistory: [],
        now: new Date("2026-08-12T12:00:00.000Z"),
        actions: operationsActions(),
      }),
    );

    expect(markup).toContain("Acknowledge incident");
    expect(markup).toContain("Resolve incident");
    expect(markup).not.toContain("Promote to live");
    expect(markup).toContain("Assign case");
  });

  it("escapes untrusted exception text", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [
          { ...exceptionFixture(), ruleCode: '<img src=x onerror="alert(1)">' },
        ],
        now: new Date("2026-08-12T12:00:00.000Z"),
      }),
    );
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).not.toContain("<img src=x");
  });

  it("allows only same-origin dashboard form submissions", () => {
    const headers = checkoutSecurityHeaders({
      nonce: "YWJjZA==",
      apiOrigin: "https://api.example.com",
      development: false,
      allowSameOriginForms: true,
    });
    expect(headers["Content-Security-Policy"]).toContain("form-action 'self'");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
});

function exceptionFixture(): PaymentException {
  return {
    id: EXCEPTION_ID,
    invoiceId: INVOICE_ID,
    attemptId: "123e4567-e89b-42d3-a456-426614174003",
    eventId: "event-001",
    signature: "4Nd1mY",
    amountBaseUnits: "125500000",
    assetSymbol: "USDT",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
    ruleCode: "wrong_amount",
    ruleVersion: "1.0.0",
    reviewState: "open",
    assignedTo: null,
    resolutionCode: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    version: 1,
    createdAt: "2026-08-12T10:00:00.000Z",
  };
}

function productionFixture(
  capabilities: {
    readonly canManageIncidents: boolean;
    readonly canPromoteProduction: boolean;
  } = { canManageIncidents: true, canPromoteProduction: true },
) {
  return {
    status: {
      activationMode: "shadow" as const,
      version: 1,
      promotedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    evaluation: {
      eligible: false,
      blockers: ["worker_heartbeat_stale" as const],
      prerequisites: {
        completeWatchCoverage: true,
        freshWorkerHeartbeat: false,
        twoActiveProductionRpcRoles: true,
        noOpenCriticalIncident: true,
      },
    },
    capabilities,
  };
}

function operationsActions() {
  const action = async () => undefined;
  return {
    assign: action,
    resolve: action,
    evidence: action,
    export: action,
    acknowledgeIncident: action,
    resolveIncident: action,
    promoteProduction: action,
  };
}

function healthFixture(
  overrides: {
    readonly measurementGeneratedAt?: string;
    readonly snapshotGeneratedAt?: string;
    readonly omitKind?: operationsApi.OperationalMeasurementKind;
  } = {},
) {
  const measurementGeneratedAt =
    overrides.measurementGeneratedAt ?? "2026-08-12T12:00:00.000Z";
  const measurements = [
    ["rpc_consensus_checks", "count", 20],
    ["rpc_consensus_disagreements", "count", 0],
    ["ingestion_gap_seconds", "seconds", 3],
    ["worker_heartbeat_age_seconds", "seconds", 45],
    ["ledger_mismatches", "count", 0],
    ["webhook_dead_letters", "count", 0],
    ["webhook_delivery_duration_milliseconds", "milliseconds", 125],
  ] as const;
  return {
    measurements: measurements
      .filter(([kind]) => kind !== overrides.omitKind)
      .map(([kind, unit, value]) => ({
        kind,
        unit,
        windowSeconds: 300 as const,
        bucketStart: "2026-08-12T11:55:00.000Z",
        value,
        sampleCount: 1,
        generatedAt: measurementGeneratedAt,
      })),
    openWarningCount: 1,
    openCriticalCount: 0,
    generatedAt: overrides.snapshotGeneratedAt ?? "2026-08-12T12:00:00.000Z",
  };
}

function incidentFixture() {
  return {
    id: EXCEPTION_ID,
    kind: "worker_stale" as const,
    severity: "warning" as const,
    state: "open" as const,
    version: 1,
    firstObservedAt: "2026-08-12T10:00:00.000Z",
    lastObservedAt: "2026-08-12T11:00:00.000Z",
    occurrenceCount: 3,
    acknowledgedAt: null,
    acknowledgedActorKind: null,
    resolvedAt: null,
    resolvedActorKind: null,
    resolutionCode: null,
    createdAt: "2026-08-12T10:00:00.000Z",
    updatedAt: "2026-08-12T11:00:00.000Z",
  };
}

function historyFixture() {
  return {
    id: "123e4567-e89b-42d3-a456-426614174003",
    incidentId: EXCEPTION_ID,
    incidentVersion: 2,
    action: "acknowledged" as const,
    fromState: "open" as const,
    toState: "acknowledged" as const,
    occurrenceCount: 3,
    actorKind: "session" as const,
    occurredAt: "2026-08-12T11:05:00.000Z",
    createdAt: "2026-08-12T11:05:00.000Z",
  };
}
