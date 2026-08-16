import { describe, expect, it } from "vitest";
import { serializePublicAnalysisCompletion } from "../lib/server/public-analysis-observability.js";

describe("public analysis observability", () => {
  it("serializes only the bounded completion schema", () => {
    const line = serializePublicAnalysisCompletion({
      event: "public_analysis_request_completed",
      requestId: "00000000-0000-4000-8000-000000000123",
      route: "/v1/public-wallet-analysis",
      statusClass: "5xx",
      durationMs: 20_001,
      code: "public_analysis_unavailable",
    });
    expect(JSON.parse(line)).toEqual({
      level: "info",
      service: "web",
      event: "public_analysis_request_completed",
      requestId: "00000000-0000-4000-8000-000000000123",
      route: "/v1/public-wallet-analysis",
      statusClass: "5xx",
      durationMs: 20_001,
      code: "public_analysis_unavailable",
    });
  });
});
