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
