import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { createPayOpsClient, PayOpsApiError } from "../src/index.js";
import type { ProductionPromotionResult } from "../src/index.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const RESOURCE_ID = "123e4567-e89b-42d3-a456-426614174001";
const SECOND_RESOURCE_ID = "123e4567-e89b-42d3-a456-426614174002";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
  });
}

describe("PayOps SDK", () => {
  test("exposes promotion outcomes as a strict discriminated union", () => {
    type Blocked = Extract<ProductionPromotionResult, { outcome: "blocked" }>;
    type Successful = Exclude<ProductionPromotionResult, Blocked>;

    expectTypeOf<Blocked>().toHaveProperty("evaluation");
    expectTypeOf<Successful>().not.toHaveProperty("evaluation");
  });

  test("is side-effect free and requires an exact HTTPS origin", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    expect(client.baseUrl).toBe("https://api.example.com");
    expect(fetch).not.toHaveBeenCalled();
    for (const value of [
      "http://api.example.com",
      "https://api.example.com/",
      "https://api.example.com/v1",
      "https://user@api.example.com",
    ]) {
      expect(() => createPayOpsClient({ baseUrl: value, fetch })).toThrow(
        "invalid_base_url",
      );
    }
  });

  test("builds authenticated list requests with encoded cursors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ data: [], nextCursor: null }));
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret-key",
      fetch,
    });
    await client.listInvoices({
      requestId: REQUEST_ID,
      limit: 25,
      cursor: "cursor+a+b/==0000",
      status: "issued",
      customerId: RESOURCE_ID,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://api.example.com/v1/invoices?limit=25&cursor=cursor%2Ba%2Bb%2F%3D%3D0000&status=issued&customerId=${RESOURCE_ID}`,
    );
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
    expect(headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(headers.get("idempotency-key")).toBeNull();
  });

  test("sends canonical mutation headers and never retries failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(
        {
          code: "conflict",
          message: "Already exists",
          requestId: REQUEST_ID,
        },
        409,
      ),
    );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    const promise = client.createCustomer(
      { displayName: "Acme" },
      { requestId: REQUEST_ID, idempotencyKey: "customer-create-42" },
    );
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      requestId: REQUEST_ID,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.body).toBe('{"displayName":"Acme"}');
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "customer-create-42",
    );
  });

  test("uses typed paths and an empty issue body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ invoice: {}, snapshot: {} }));
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    await client.issueInvoice(RESOURCE_ID, {
      requestId: REQUEST_ID,
      idempotencyKey: "issue-invoice-0001",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://api.example.com/v1/invoices/${RESOURCE_ID}/issue`,
    );
    expect(init?.body).toBe("{}");
  });

  test("creates hosted checkout links and exact payment attempts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(
          {
            checkoutId: RESOURCE_ID,
            checkoutUrl: "https://pay.example.com/pay/capability",
            createdAt: "2026-08-12T12:00:00.000Z",
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json({ publicAttemptId: RESOURCE_ID, assetSymbol: "USDC" }, 201),
      );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret-key",
      fetch,
    });
    await client.createCheckoutLink(RESOURCE_ID, { requestId: REQUEST_ID });
    await client.createPaymentAttempt(
      RESOURCE_ID,
      { assetSymbol: "USDC" },
      { requestId: REQUEST_ID },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const [linkUrl, linkInit] = fetch.mock.calls[0] ?? [];
    const [attemptUrl, attemptInit] = fetch.mock.calls[1] ?? [];
    expect(String(linkUrl)).toBe(
      `https://api.example.com/v1/invoices/${RESOURCE_ID}/checkout-links`,
    );
    expect(String(attemptUrl)).toBe(
      `https://api.example.com/v1/invoices/${RESOURCE_ID}/payment-attempts`,
    );
    expect(linkInit?.body).toBe("{}");
    expect(attemptInit?.body).toBe('{"assetSymbol":"USDC"}');
    expect(new Headers(linkInit?.headers).get("idempotency-key")).toBeNull();
  });

  test("operates the payment exception inbox with optimistic versions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ data: [], nextCursor: null }))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ id: RESOURCE_ID, version: 2 }))
      .mockResolvedValueOnce(json({ id: RESOURCE_ID, version: 3 }))
      .mockResolvedValueOnce(json({ id: RESOURCE_ID, version: 4 }))
      .mockResolvedValueOnce(json({ id: RESOURCE_ID, version: 5 }))
      .mockResolvedValueOnce(json({ id: RESOURCE_ID, version: 6 }));
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });

    await client.listPaymentExceptions({
      requestId: REQUEST_ID,
      state: "assigned",
      limit: 20,
      cursor: "cursor-for-exceptions-0001",
    });
    await client.getPaymentExceptionHistory(RESOURCE_ID, {
      requestId: REQUEST_ID,
    });
    await client.assignPaymentException(
      RESOURCE_ID,
      {
        assignee: "ops@example.com",
        note: "Investigating",
        expectedVersion: 1,
      },
      { requestId: REQUEST_ID, idempotencyKey: "assign-exception-0001" },
    );
    await client.resolvePaymentException(
      RESOURCE_ID,
      {
        resolutionCode: "leave_unapplied",
        note: "No matching invoice",
        expectedVersion: 2,
      },
      { requestId: REQUEST_ID, idempotencyKey: "resolve-exception-0001" },
    );
    const transition = { reasonCode: "operator_review", expectedVersion: 3 };
    await client.startPaymentExceptionInvestigation(RESOURCE_ID, transition, {
      requestId: REQUEST_ID,
      idempotencyKey: "investigate-exception-0001",
    });
    await client.escalatePaymentException(RESOURCE_ID, transition, {
      requestId: REQUEST_ID,
      idempotencyKey: "escalate-exception-0001",
    });
    await client.reopenPaymentException(RESOURCE_ID, transition, {
      requestId: REQUEST_ID,
      idempotencyKey: "reopen-exception-0001",
    });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.example.com/v1/exceptions?limit=20&cursor=cursor-for-exceptions-0001&state=assigned",
    );
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      `https://api.example.com/v1/exceptions/${RESOURCE_ID}/history`,
    );
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(
      '{"assignee":"ops@example.com","note":"Investigating","expectedVersion":1}',
    );
    expect(
      new Headers(fetch.mock.calls[3]?.[1]?.headers).get("idempotency-key"),
    ).toBe("resolve-exception-0001");
    expect(fetch.mock.calls.slice(4).map((call) => String(call[0]))).toEqual([
      `https://api.example.com/v1/exceptions/${RESOURCE_ID}/investigate`,
      `https://api.example.com/v1/exceptions/${RESOURCE_ID}/escalate`,
      `https://api.example.com/v1/exceptions/${RESOURCE_ID}/reopen`,
    ]);
  });

  test("creates and downloads bounded evidence and accounting exports", async () => {
    const bytes = new TextEncoder().encode("signed evidence");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ id: RESOURCE_ID }, 201))
      .mockResolvedValueOnce(
        new Response(bytes, {
          headers: {
            "content-type": "application/pdf",
            "content-length": "15",
            "x-payops-manifest-digest": "d".repeat(64),
            "x-payops-signature": "s".repeat(86),
            "x-payops-signing-key-id": "key-2026-08",
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          evidencePackId: RESOURCE_ID,
          algorithm: "Ed25519",
          digestAlgorithm: "SHA-256",
          manifestDigest: "d".repeat(64),
          signature: "s".repeat(86),
          signingKeyId: "key-2026-08",
          publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
        }),
      )
      .mockResolvedValueOnce(json({ id: SECOND_RESOURCE_ID }, 201))
      .mockResolvedValueOnce(
        new Response("date,amount\r\n2026-08-12,100\r\n", {
          headers: {
            "content-type": "text/csv",
            "x-payops-content-digest": "c".repeat(64),
          },
        }),
      );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });

    await client.createEvidencePack(
      { invoiceId: RESOURCE_ID },
      { requestId: REQUEST_ID, idempotencyKey: "evidence-pack-0001" },
    );
    const evidence = await client.downloadEvidencePack(RESOURCE_ID, "pdf", {
      requestId: REQUEST_ID,
    });
    expect(new TextDecoder().decode(evidence.bytes)).toBe("signed evidence");
    expect(evidence).toMatchObject({
      manifestDigest: "d".repeat(64),
      signature: "s".repeat(86),
      signingKeyId: "key-2026-08",
    });
    await expect(
      client.getEvidencePackVerification(RESOURCE_ID, {
        requestId: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ signingKeyId: "key-2026-08" });
    await client.createAccountingExport(
      {
        format: "quickbooks_csv",
        fromTime: "2026-08-01T00:00:00.000Z",
        throughTime: "2026-08-12T00:00:00.000Z",
      },
      { requestId: REQUEST_ID, idempotencyKey: "accounting-export-0001" },
    );
    const csv = await client.downloadAccountingExport(SECOND_RESOURCE_ID, {
      requestId: REQUEST_ID,
    });

    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      `https://api.example.com/v1/evidence-packs/${RESOURCE_ID}?format=pdf`,
    );
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("accept")).toBe(
      "application/pdf",
    );
    expect(String(fetch.mock.calls[4]?.[0])).toBe(
      `https://api.example.com/v1/exports/${SECOND_RESOURCE_ID}`,
    );
    expect(new TextDecoder().decode(csv.bytes)).toContain("2026-08-12,100");
    expect(csv.contentDigest).toBe("c".repeat(64));
  });

  test("rejects invalid exception filters and oversized binary responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("x", {
        headers: {
          "content-type": "application/pdf",
          "content-length": "52428801",
        },
      }),
    );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });

    expect(() =>
      client.listPaymentExceptions({ state: "invalid" as "open" }),
    ).toThrow("invalid_exception_state");
    await expect(
      client.downloadEvidencePack(RESOURCE_ID, "pdf"),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  test("fails closed when evidence verification headers are missing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("pdf", {
        headers: { "content-type": "application/pdf" },
      }),
    );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    await expect(
      client.downloadEvidencePack(RESOURCE_ID, "pdf", {
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_api_response" });
  });

  test("rejects invalid identifiers and header injection before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    expect(() => client.getInvoice("../other")).toThrow("invalid_resource_id");
    await expect(
      client.createCustomer(
        { displayName: "Acme" },
        { idempotencyKey: "valid\r\nX-Evil: yes" },
      ),
    ).rejects.toThrow("invalid_idempotency_key");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("maps malformed and oversized responses to bounded typed errors", async () => {
    const malformed = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch: async () =>
        new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(malformed.getOrganization()).rejects.toMatchObject({
      code: "invalid_api_response",
    });

    const oversized = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch: async () => json({ value: "x".repeat(1_048_576) }),
    });
    await expect(oversized.getOrganization()).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  test("preserves caller cancellation and applies a bounded timeout", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
      timeoutMs: 10,
    });
    await expect(client.getOrganization()).rejects.toBeDefined();

    const controller = new AbortController();
    controller.abort(new Error("caller_cancelled"));
    await expect(
      client.getOrganization({ signal: controller.signal }),
    ).rejects.toThrow("caller_cancelled");
  });

  test("exports a safe API error without retaining raw bodies or credentials", () => {
    const error = new PayOpsApiError({
      status: 401,
      code: "authentication_required",
      message: "Authentication is required",
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(error).toBeInstanceOf(Error);
  });

  test("exposes every operational read path with exact opaque pagination", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ status: {}, evaluation: {} }))
      .mockResolvedValueOnce(json({ measurements: [] }))
      .mockResolvedValueOnce(json({ data: [], nextCursor: null }))
      .mockResolvedValueOnce(json({ data: [], nextCursor: null }));
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      apiKey: "operations-read-key",
      fetch,
    });

    await client.getProductionControl({ requestId: REQUEST_ID });
    await client.getOperationalHealth({ requestId: REQUEST_ID });
    await client.listOperationalIncidents({
      requestId: REQUEST_ID,
      limit: 20,
      cursor: "opaque-incident-cursor-0001",
      state: "acknowledged",
      kind: "worker_stale",
    });
    await client.getOperationalIncidentHistory(RESOURCE_ID, {
      requestId: REQUEST_ID,
      limit: 10,
      cursor: "opaque-history-cursor-0001",
    });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.com/v1/operations/production-control",
      "https://api.example.com/v1/operations/health",
      "https://api.example.com/v1/operations/incidents?limit=20&cursor=opaque-incident-cursor-0001&state=acknowledged&kind=worker_stale",
      `https://api.example.com/v1/operations/incidents/${RESOURCE_ID}/history?limit=10&cursor=opaque-history-cursor-0001`,
    ]);
  });

  test("sends exact zero-retry operational mutations", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ id: RESOURCE_ID, version: 2 }))
      .mockResolvedValueOnce(json({ id: RESOURCE_ID, version: 3 }))
      .mockResolvedValueOnce(
        json(
          {
            code: "production_control_version_conflict",
            message: "Operation could not be completed",
            requestId: REQUEST_ID,
            ignoredRawContext: "provider-secret",
          },
          409,
        ),
      );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      apiKey: "credential-must-not-leak",
      sessionCookie: "payops.session_token=session-must-not-leak",
      sessionOrigin: "https://merchant.example.com",
      fetch,
    });
    const mutation = {
      requestId: REQUEST_ID,
      idempotencyKey: "ops-mutation-00000001",
    };

    await client.acknowledgeOperationalIncident(
      RESOURCE_ID,
      { expectedVersion: 1 },
      mutation,
    );
    await client.resolveOperationalIncident(
      RESOURCE_ID,
      { expectedVersion: 2, resolutionCode: "operator_resolved" },
      { ...mutation, idempotencyKey: "ops-mutation-00000002" },
    );
    const promotion = client.promoteProductionLive(
      { confirmed: true, expectedVersion: 1 },
      { ...mutation, idempotencyKey: "ops-mutation-00000003" },
    );
    await expect(promotion).rejects.toMatchObject({
      status: 409,
      code: "production_control_version_conflict",
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.example.com/v1/operations/incidents/${RESOURCE_ID}/acknowledge`,
      `https://api.example.com/v1/operations/incidents/${RESOURCE_ID}/resolve`,
      "https://api.example.com/v1/operations/production-control/promote",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual([
      '{"expectedVersion":1}',
      '{"expectedVersion":2,"resolutionCode":"operator_resolved"}',
      '{"confirmed":true,"expectedVersion":1}',
    ]);
    for (const [, init] of fetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe(
        "payops.session_token=session-must-not-leak",
      );
      expect(headers.get("origin")).toBe("https://merchant.example.com");
      expect(headers.has("x-api-key")).toBe(false);
    }
    const error = await promotion.catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain("credential-must-not-leak");
    expect(JSON.stringify(error)).not.toContain("session-must-not-leak");
    expect(JSON.stringify(error)).not.toContain("provider-secret");
  });

  test("requires one bounded server-side session cookie for session-only mutations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const apiKeyClient = createPayOpsClient({
      baseUrl: "https://api.example.com",
      apiKey: "read-only-api-key",
      fetch,
    });
    await expect(
      apiKeyClient.acknowledgeOperationalIncident(
        RESOURCE_ID,
        { expectedVersion: 1 },
        { idempotencyKey: "session-required-test-0001" },
      ),
    ).rejects.toThrow("session_cookie_required");
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      createPayOpsClient({
        baseUrl: "https://api.example.com",
        sessionCookie: "payops.session_token=valid",
      }),
    ).toThrow("invalid_session_authentication");
    expect(() =>
      createPayOpsClient({
        baseUrl: "https://api.example.com",
        sessionCookie: "payops.session_token=valid",
        sessionOrigin: "https://merchant.example.com/path",
      }),
    ).toThrow("invalid_session_origin");
    expect(() =>
      createPayOpsClient({
        baseUrl: "https://api.example.com",
        sessionCookie: "payops.session_token=unsafe\r\ninjected=true",
      }),
    ).toThrow("invalid_session_cookie");
    expect(() =>
      createPayOpsClient({
        baseUrl: "https://api.example.com",
        sessionCookie: `payops.session_token=${"x".repeat(4_096)}`,
      }),
    ).toThrow("invalid_session_cookie");
  });

  test("bounds operational responses and rejects invalid closed-enum filters", async () => {
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch: async () => json({ value: "x".repeat(1_048_576) }),
    });
    await expect(client.getOperationalHealth()).rejects.toMatchObject({
      code: "response_too_large",
    });
    expect(() =>
      client.listOperationalIncidents({ state: "active" as "open" }),
    ).toThrow("invalid_operational_incident_state");
    expect(() =>
      client.listOperationalIncidents({
        kind: "provider_url" as "worker_stale",
      }),
    ).toThrow("invalid_operational_incident_kind");
  });
});
