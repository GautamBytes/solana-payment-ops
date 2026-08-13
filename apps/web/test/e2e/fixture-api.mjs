import { createServer } from "node:http";

const token = "A".repeat(43);
const webOrigin = "http://127.0.0.1:3400";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const recipient = "11111111111111111111111111111111";
const reference = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const baseAttempt = {
  publicAttemptId: "00000000-0000-4000-8000-000000000101",
  assetSymbol: "USDC",
  mint,
  amountTokens: "125.50",
  amountBaseUnits: "125500000",
  paymentUrl: `solana:${recipient}?amount=125.50&spl-token=${mint}&reference=${reference}&label=Acme%20Exports&message=Invoice%20INV-1042`,
  reference,
  quoteExpiresAt: "2099-01-01T00:00:00.000Z",
  status: "awaiting_payment",
  statusUpdatedAt: "2026-08-12T00:00:00.000Z",
};
const checkout = {
  schemaVersion: "0.1",
  merchant: { displayName: "Acme Exports" },
  invoice: {
    publicReference: "INV-1042",
    currency: "USD",
    totalMinorUnits: "12550",
    dueAt: "2026-08-30T12:00:00.000Z",
    status: "issued",
  },
  acceptedAssets: [
    { symbol: "USDC", mint, decimals: 6 },
    {
      symbol: "USDT",
      mint: "Es9vMFrzaCERmJfrF4H2FYD5Uw8pGmLZVgFZkQwVRhD",
      decimals: 6,
    },
  ],
  currentAttempt: null,
};
const operationsException = {
  id: "00000000-0000-4000-8000-000000000201",
  invoiceId: "00000000-0000-4000-8000-000000000202",
  attemptId: "00000000-0000-4000-8000-000000000203",
  eventId: "payment-exception-201",
  signature: "4Nd1mYfYhG9Q2WbLAh2R6eqn",
  amountBaseUnits: "125500000",
  assetSymbol: "USDC",
  mint,
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
const operationalIncident = {
  id: "00000000-0000-4000-8000-000000000206",
  kind: "worker_stale",
  severity: "warning",
  state: "open",
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

let state = resetState("static");

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:3401");
  if (url.pathname === "/__test/health")
    return json(response, 200, { ok: true });
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    const body = await readJson(request);
    state = resetState(
      typeof body.scenario === "string" ? body.scenario : "static",
    );
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/__test/state") {
    return json(response, 200, state);
  }
  if (request.method === "OPTIONS") {
    cors(response);
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === "/v1/exceptions" && request.method === "GET") {
    if (["viewer", "developer"].includes(state.scenario)) {
      return json(response, 403, { code: "forbidden" });
    }
    if (state.scenario === "exception-unavailable") {
      return json(response, 503, { code: "exceptions_unavailable" });
    }
    const requestedState = url.searchParams.get("state");
    return json(response, 200, {
      data:
        requestedState === null ||
        requestedState === state.exception.reviewState
          ? [state.exception]
          : [],
      nextCursor: null,
    });
  }
  if (
    url.pathname === "/v1/operations/production-control" &&
    request.method === "GET"
  ) {
    const stale = state.scenario === "operations-stale";
    return json(response, 200, {
      status: {
        activationMode: state.activationMode,
        version: state.activationMode === "live" ? 2 : 1,
        promotedAt:
          state.activationMode === "live" ? new Date().toISOString() : null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
      evaluation: {
        eligible: !stale,
        blockers: stale ? ["worker_heartbeat_stale"] : [],
        prerequisites: {
          completeWatchCoverage: true,
          freshWorkerHeartbeat: !stale,
          twoActiveProductionRpcRoles: true,
          noOpenCriticalIncident: true,
        },
      },
      capabilities: {
        canManageIncidents: !["viewer", "developer"].includes(state.scenario),
        canPromoteProduction: !["viewer", "developer", "operator"].includes(
          state.scenario,
        ),
      },
    });
  }
  if (url.pathname === "/v1/operations/health" && request.method === "GET") {
    const generatedAt = new Date(
      Date.now() - (state.scenario === "operations-stale" ? 3_600_000 : 0),
    ).toISOString();
    const measurements = [
      ["rpc_consensus_checks", "count", 20],
      ["rpc_consensus_disagreements", "count", 0],
      ["ingestion_gap_seconds", "seconds", 3],
      ["worker_heartbeat_age_seconds", "seconds", 12],
      ["ledger_mismatches", "count", 0],
      ["webhook_dead_letters", "count", 0],
      ["webhook_delivery_duration_milliseconds", "milliseconds", 125],
    ];
    return json(response, 200, {
      measurements: measurements.map(([kind, unit, value]) => ({
        kind,
        unit,
        windowSeconds: 300,
        bucketStart: new Date(Date.now() - 300_000).toISOString(),
        value,
        sampleCount: 1,
        generatedAt,
      })),
      openWarningCount: 1,
      openCriticalCount: 0,
      generatedAt: new Date().toISOString(),
    });
  }
  if (url.pathname === "/v1/operations/incidents" && request.method === "GET") {
    return json(response, 200, {
      data: state.incident.state === "resolved" ? [] : [state.incident],
      nextCursor: null,
    });
  }
  if (
    url.pathname ===
      `/v1/operations/incidents/${operationalIncident.id}/history` &&
    request.method === "GET"
  ) {
    return json(response, 200, {
      data: [
        {
          id: "00000000-0000-4000-8000-000000000207",
          incidentId: operationalIncident.id,
          incidentVersion: 1,
          action: "opened",
          fromState: null,
          toState: "open",
          occurrenceCount: 1,
          actorKind: "system",
          occurredAt: operationalIncident.firstObservedAt,
          createdAt: operationalIncident.firstObservedAt,
        },
      ],
      nextCursor: null,
    });
  }
  if (
    url.pathname ===
      `/v1/operations/incidents/${operationalIncident.id}/acknowledge` &&
    request.method === "POST"
  ) {
    if (state.scenario === "operations-conflict") {
      return json(response, 409, {
        code: "incident_version_conflict",
        message: "Operation could not be completed",
        requestId: "00000000-0000-4000-8000-000000000208",
      });
    }
    state.incident = {
      ...state.incident,
      state: "acknowledged",
      version: state.incident.version + 1,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedActorKind: "session",
    };
    return json(response, 200, state.incident);
  }
  if (
    url.pathname ===
      `/v1/operations/incidents/${operationalIncident.id}/resolve` &&
    request.method === "POST"
  ) {
    state.incident = {
      ...state.incident,
      state: "resolved",
      version: state.incident.version + 1,
      resolvedAt: new Date().toISOString(),
      resolvedActorKind: "session",
      resolutionCode: "operator_resolved",
    };
    return json(response, 200, state.incident);
  }
  if (
    url.pathname === "/v1/operations/production-control/promote" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (body.confirmed !== true) {
      return json(response, 400, { code: "invalid_request" });
    }
    state.activationMode = "live";
    return json(response, 200, {
      outcome: "promoted",
      status: {
        activationMode: "live",
        version: 2,
        promotedAt: new Date().toISOString(),
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
      },
    });
  }
  if (
    url.pathname === `/v1/exceptions/${operationsException.id}/assign` &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    state.exception = {
      ...state.exception,
      reviewState: "assigned",
      assignedTo: body.assignee,
      version: state.exception.version + 1,
    };
    return json(response, 200, state.exception);
  }
  if (url.pathname === "/v1/evidence-packs" && request.method === "POST") {
    const body = await readJson(request);
    return json(response, 201, {
      id: "00000000-0000-4000-8000-000000000204",
      invoiceId: body.invoiceId,
    });
  }
  if (url.pathname === "/v1/exports" && request.method === "POST") {
    const body = await readJson(request);
    return json(response, 201, {
      id: "00000000-0000-4000-8000-000000000205",
      format: body.format,
    });
  }
  if (url.pathname === `/pay/${token}` && request.method === "GET") {
    return json(response, 200, {
      ...checkout,
      currentAttempt: state.attempt,
    });
  }
  if (url.pathname === `/pay/${token}/quotes` && request.method === "POST") {
    cors(response);
    const key = request.headers["idempotency-key"];
    state.keys.push(typeof key === "string" ? key : "");
    state.quoteCalls += 1;
    if (
      state.scenario === "refresh-fail" ||
      (state.scenario === "quote-retry" && state.quoteCalls === 1)
    ) {
      return json(response, 503, { code: "quote_unavailable" });
    }
    state.attempt = { ...baseAttempt };
    return json(response, 201, state.attempt);
  }
  if (url.pathname === `/pay/${token}/status` && request.method === "GET") {
    cors(response);
    state.statusCalls += 1;
    if (state.scenario === "transition" && state.attempt !== null) {
      if (state.statusCalls >= 3) {
        state.attempt = {
          ...state.attempt,
          status: state.statusCalls >= 4 ? "paid" : "detected",
          statusUpdatedAt: new Date().toISOString(),
        };
      }
    }
    return json(response, 200, {
      invoiceStatus: state.attempt?.status === "paid" ? "paid" : "issued",
      currentAttempt: state.attempt,
    });
  }
  json(response, 404, { code: "not_found" });
}).listen(3401, "127.0.0.1");

function resetState(scenario) {
  return {
    scenario,
    attempt:
      scenario === "expired" || scenario === "refresh-fail"
        ? expiredAttempt()
        : null,
    quoteCalls: 0,
    statusCalls: 0,
    keys: [],
    exception: { ...operationsException },
    incident: { ...operationalIncident },
    activationMode: "shadow",
  };
}

function expiredAttempt() {
  return {
    ...baseAttempt,
    quoteExpiresAt: "2026-01-01T00:00:00.000Z",
    status: "expired",
  };
}

function cors(response) {
  response.setHeader("access-control-allow-origin", webOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type,idempotency-key,if-none-match",
  );
  response.setHeader("vary", "origin");
}

function json(response, status, body) {
  cors(response);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
