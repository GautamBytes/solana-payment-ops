import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import { describe, expect, it } from "vitest";
import { installErrorHandler, ApiError } from "../src/protocol/api-error.js";
import {
  cursorFilterDigest,
  decodeCursor,
  decodeVersionCursor,
  encodeCursor,
  encodeVersionCursor,
  parseLimit,
} from "../src/protocol/cursor.js";
import { installRequestContext } from "../src/protocol/request-context.js";

describe("API protocol", () => {
  it("logs only stable fields for rejected API requests", async () => {
    const captured: Record<string, unknown>[] = [];
    const server = Fastify({
      logger: {
        level: "info",
        stream: {
          write(line: string) {
            captured.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      },
      logController: new LogController({ disableRequestLogging: true }),
    });
    installRequestContext(server);
    installErrorHandler(server);
    server.get("/limited", async () => {
      throw new ApiError(
        429,
        "rate_limit_exceeded",
        "Rate limit exceeded for wallet SecretWalletAddress",
      );
    });
    try {
      const response = await server.inject({
        method: "GET",
        url: "/limited",
        headers: { authorization: "Bearer secret-token" },
      });
      expect(response.statusCode).toBe(429);
      expect(captured).toContainEqual(
        expect.objectContaining({
          event: "api_request_rejected",
          code: "rate_limit_exceeded",
          route: "/limited",
          statusClass: "4xx",
        }),
      );
      const serialized = JSON.stringify(captured);
      expect(serialized).not.toContain("SecretWalletAddress");
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("Rate limit exceeded");
    } finally {
      await server.close();
    }
  });

  it("binds a canonical request ID and emits stable bounded errors", async () => {
    const server = Fastify({ bodyLimit: 256 * 1_024 });
    installRequestContext(server);
    installErrorHandler(server);
    server.post("/known", async () => {
      throw new ApiError(409, "known_conflict", "Known conflict", {
        field: "name",
      });
    });
    server.post("/unknown", async () => {
      throw new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("secret prototype");
          },
          getOwnPropertyDescriptor: () => {
            throw new Error("secret");
          },
        },
      );
    });
    try {
      const requestId = randomUUID();
      const known = await server.inject({
        method: "POST",
        url: "/known",
        headers: {
          "x-request-id": requestId,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(known.headers["x-request-id"]).toBe(requestId);
      expect(known.json()).toEqual({
        code: "known_conflict",
        message: "Known conflict",
        requestId,
        details: { field: "name" },
      });

      const malformed = await server.inject({
        method: "POST",
        url: "/unknown",
        headers: {
          "x-request-id": "not-a-uuid",
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(malformed.statusCode).toBe(500);
      expect(malformed.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(malformed.body).not.toContain("secret");
    } finally {
      await server.close();
    }
  });

  it("binds opaque cursors to endpoint, organization, sort, and filters", () => {
    const filterDigest = cursorFilterDigest({
      endpoint: "customers.list",
      organizationId: randomUUID(),
      sort: "created_desc",
      filters: { externalId: null },
    });
    const position = {
      createdAt: "2026-08-12T00:00:00.000Z",
      id: randomUUID(),
    };
    const cursor = encodeCursor(position, filterDigest);
    expect(decodeCursor(cursor, filterDigest)).toEqual(position);
    expect(() => decodeCursor(cursor, "a".repeat(64))).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
    expect(() => decodeCursor("A".repeat(1_025), filterDigest)).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("100")).toBe(100);
    for (const value of ["0", "101", "01", "1.5", ["1", "2"]]) {
      expect(() => parseLimit(value)).toThrowError(
        expect.objectContaining({ code: "invalid_cursor" }),
      );
    }
  });

  it("binds descending integer-version cursors without weakening date cursors", () => {
    const filterDigest = cursorFilterDigest({
      endpoint: "operations.incidents.history",
      organizationId: randomUUID(),
      sort: "incident_version_desc",
      filters: { incidentId: randomUUID() },
    });
    const position = { incidentVersion: 7, id: randomUUID() };
    const cursor = encodeVersionCursor(position, filterDigest);
    expect(decodeVersionCursor(cursor, filterDigest)).toEqual(position);
    expect(() => decodeVersionCursor(cursor, "b".repeat(64))).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
    expect(() =>
      encodeVersionCursor({ ...position, incidentVersion: 0 }, filterDigest),
    ).toThrowError(expect.objectContaining({ code: "invalid_cursor" }));
    expect(() => decodeCursor(cursor, filterDigest)).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
  });
});
