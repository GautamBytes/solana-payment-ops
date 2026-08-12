import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { IdempotencyResponseCommitter } from "@payops/platform";
import { describe, expect, it } from "vitest";
import type { RequestActor } from "../src/auth/context.js";
import { errorBody } from "../src/protocol/api-error.js";
import { installRequestContext } from "../src/protocol/request-context.js";
import { registerOperationRoutes } from "../src/routes/operations.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const exceptionId = "00000000-0000-4000-8000-000000000002";
const invoiceId = "00000000-0000-4000-8000-000000000003";
const evidenceId = "00000000-0000-4000-8000-000000000004";
const exportId = "00000000-0000-4000-8000-000000000005";

describe("merchant operation routes", () => {
  it("lists, assigns, and resolves tenant exceptions through strict idempotent routes", async () => {
    const fixture = createFixture();
    try {
      const listed = await fixture.server.inject({
        method: "GET",
        url: "/v1/exceptions?state=open&limit=20",
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({
        data: [
          expect.objectContaining({ id: exceptionId, reviewState: "open" }),
        ],
        nextCursor: null,
      });
      const missingKey = await fixture.server.inject({
        method: "POST",
        url: `/v1/exceptions/${exceptionId}/assign`,
        payload: { assignee: "finance@example.com", expectedVersion: 1 },
      });
      expect(missingKey.statusCode).toBe(400);
      const assigned = await fixture.server.inject({
        method: "POST",
        url: `/v1/exceptions/${exceptionId}/assign`,
        headers: { "idempotency-key": "assign-exception-00000001" },
        payload: {
          assignee: "finance@example.com",
          note: "Investigate remittance",
          expectedVersion: 1,
        },
      });
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json()).toMatchObject({
        reviewState: "assigned",
        version: 2,
      });
      for (const [action, state] of [
        ["investigate", "investigating"],
        ["escalate", "escalated"],
        ["reopen", "open"],
      ] as const) {
        const transitioned = await fixture.server.inject({
          method: "POST",
          url: `/v1/exceptions/${exceptionId}/${action}`,
          headers: { "idempotency-key": `${action}-exception-00000001` },
          payload: { reasonCode: "operator_review", expectedVersion: 2 },
        });
        expect(transitioned.statusCode).toBe(200);
        expect(transitioned.json()).toMatchObject({ reviewState: state });
      }
      const resolved = await fixture.server.inject({
        method: "POST",
        url: `/v1/exceptions/${exceptionId}/resolve`,
        headers: { "idempotency-key": "resolve-exception-0000001" },
        payload: {
          resolutionCode: "leave_unapplied",
          note: "Await customer direction",
          expectedVersion: 2,
        },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({
        reviewState: "resolved",
        version: 3,
      });
    } finally {
      await fixture.server.close();
    }
  });

  it("creates and downloads signed evidence and deterministic exports", async () => {
    const fixture = createFixture();
    try {
      const evidence = await fixture.server.inject({
        method: "POST",
        url: "/v1/evidence-packs",
        headers: { "idempotency-key": "generate-evidence-0000001" },
        payload: { invoiceId },
      });
      expect(evidence.statusCode).toBe(201);
      expect(evidence.json()).toMatchObject({
        id: evidenceId,
        manifestDigest: "d".repeat(64),
        jsonUrl: `/v1/evidence-packs/${evidenceId}?format=json`,
        pdfUrl: `/v1/evidence-packs/${evidenceId}?format=pdf`,
        verificationUrl: `/v1/evidence-packs/${evidenceId}/verification`,
      });
      const pdf = await fixture.server.inject({
        method: "GET",
        url: `/v1/evidence-packs/${evidenceId}?format=pdf`,
      });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      expect(pdf.rawPayload.toString()).toBe("%PDF-1.4 test");
      expect(pdf.headers["x-payops-manifest-digest"]).toBe("d".repeat(64));
      const verification = await fixture.server.inject({
        method: "GET",
        url: `/v1/evidence-packs/${evidenceId}/verification`,
      });
      expect(verification.statusCode).toBe(200);
      expect(verification.json()).toMatchObject({
        evidencePackId: evidenceId,
        signingKeyId: "test-key",
        algorithm: "Ed25519",
      });

      const generated = await fixture.server.inject({
        method: "POST",
        url: "/v1/exports",
        headers: { "idempotency-key": "generate-export-00000001" },
        payload: {
          format: "journals_csv",
          fromTime: "2026-08-01T00:00:00.000Z",
          throughTime: "2026-08-13T00:00:00.000Z",
        },
      });
      expect(generated.statusCode).toBe(201);
      expect(generated.json()).toMatchObject({
        id: exportId,
        downloadUrl: `/v1/exports/${exportId}`,
      });
      const csv = await fixture.server.inject({
        method: "GET",
        url: `/v1/exports/${exportId}`,
      });
      expect(csv.statusCode).toBe(200);
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.body).toBe("Header\r\nValue\r\n");
      expect(csv.headers["cache-control"]).toBe("private, no-store");
      expect(csv.headers["x-payops-content-digest"]).toBe("e".repeat(64));
    } finally {
      await fixture.server.close();
    }
  });
});

function createFixture() {
  const server = Fastify();
  installRequestContext(server);
  const actor: RequestActor = {
    kind: "session",
    actorId: "merchant-user",
    organizationId,
    role: "owner",
    permissions: {
      organizationRead: true,
      memberAdmin: true,
      apiKeyAdmin: true,
      walletRead: true,
      walletAdmin: true,
      customerRead: true,
      customerWrite: true,
      invoiceRead: true,
      invoiceWrite: true,
      invoiceIssue: true,
      paymentReview: true,
      accountingRead: true,
    },
    sessionCreatedAt: new Date(),
    twoFactorEnabled: true,
  };
  const manifestBytes = new TextEncoder().encode('{"schemaVersion":"0.1"}');
  const pdfBytes = new TextEncoder().encode("%PDF-1.4 test");
  const csvBytes = new TextEncoder().encode("Header\r\nValue\r\n");
  registerOperationRoutes(server, {
    auth: { resolve: async () => actor, close: async () => undefined },
    rateLimits: {
      consume: async () => ({
        allowed: true,
        limit: 600,
        remaining: 599,
        retryAfterSeconds: 0,
      }),
    },
    idempotency: new TestIdempotency(),
    exceptions: {
      list: async () => [exceptionRecord("open", 1)],
      history: async () => [],
      assign: async () => exceptionRecord("assigned", 2),
      startInvestigation: async () => exceptionRecord("investigating", 2),
      escalate: async () => exceptionRecord("escalated", 2),
      reopen: async () => exceptionRecord("open", 2),
      resolve: async () => exceptionRecord("resolved", 3),
    },
    evidence: {
      generate: async () => ({
        id: evidenceId,
        invoiceId,
        schemaVersion: "0.1",
        manifestBytes,
        pdfBytes,
        manifestDigest: "d".repeat(64),
        signature: new Uint8Array(64),
        signingKeyId: "test-key",
        publicKeyPem:
          "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
        generatedAt: "2026-08-12T00:00:00.000Z",
      }),
      get: async () => ({
        id: evidenceId,
        invoiceId,
        schemaVersion: "0.1",
        manifestBytes,
        pdfBytes,
        manifestDigest: "d".repeat(64),
        signature: new Uint8Array(64),
        signingKeyId: "test-key",
        publicKeyPem:
          "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
        generatedAt: "2026-08-12T00:00:00.000Z",
      }),
    },
    exports: {
      generate: async () => ({
        id: exportId,
        format: "journals_csv",
        fromTime: "2026-08-01T00:00:00.000Z",
        throughTime: "2026-08-13T00:00:00.000Z",
        contentBytes: csvBytes,
        contentDigest: "e".repeat(64),
        rowCount: 1,
        generatedAt: "2026-08-13T00:01:00.000Z",
      }),
      get: async () => ({
        id: exportId,
        format: "journals_csv",
        fromTime: "2026-08-01T00:00:00.000Z",
        throughTime: "2026-08-13T00:00:00.000Z",
        contentBytes: csvBytes,
        contentDigest: "e".repeat(64),
        rowCount: 1,
        generatedAt: "2026-08-13T00:01:00.000Z",
      }),
    },
  });
  return { server };
}

class TestIdempotency {
  public async execute(
    request: FastifyRequest,
    reply: FastifyReply,
    _actor: RequestActor,
    _routeId: string,
    _path: Readonly<Record<string, string>>,
    _body: unknown,
    operation: (_committer: IdempotencyResponseCommitter) => Promise<{
      readonly status: number;
      readonly body: unknown;
    }>,
  ) {
    if (typeof request.headers["idempotency-key"] !== "string") {
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
    const result = await operation({
      complete: async () => undefined,
    });
    return reply.code(result.status).send(result.body);
  }
}

function exceptionRecord(
  reviewState: "open" | "assigned" | "investigating" | "escalated" | "resolved",
  version: number,
) {
  return {
    id: exceptionId,
    invoiceId,
    attemptId: "00000000-0000-4000-8000-000000000006",
    eventId: "event-1",
    signature: "1".repeat(64),
    amountBaseUnits: "1000000",
    assetSymbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    ruleCode: "partial_payment",
    ruleVersion: "0.1",
    reviewState,
    assignedTo: reviewState === "open" ? null : "finance@example.com",
    resolutionCode: reviewState === "resolved" ? "leave_unapplied" : null,
    resolutionNote:
      reviewState === "resolved" ? "Await customer direction" : null,
    resolvedBy: reviewState === "resolved" ? "merchant-user" : null,
    resolvedAt: reviewState === "resolved" ? "2026-08-12T00:00:00.000Z" : null,
    version,
    createdAt: "2026-08-12T00:00:00.000Z",
  } as const;
}
