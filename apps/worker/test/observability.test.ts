import { describe, expect, it } from "vitest";
import { serializeOperationalEvent } from "../src/observability.js";

describe("worker observability", () => {
  it("serializes stable JSON and drops fields outside the safe schema", () => {
    const line = serializeOperationalEvent(
      "info",
      "worker_job_completed",
      {
        instanceId: "8a75f976-0f1d-4df8-a8ac-2fc79be6cfa9",
        operationId: "4749afac-3ee4-4bec-a440-9775307b549f",
        job: "send_webhooks",
        wallet: "SecretWallet",
        signature: "SecretSignature",
        authorization: "Bearer secret",
        cookie: "secret-cookie",
      } as never,
      new Date("2026-08-17T00:00:00.000Z"),
    );
    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-08-17T00:00:00.000Z",
      level: "info",
      service: "worker",
      event: "worker_job_completed",
      instanceId: "8a75f976-0f1d-4df8-a8ac-2fc79be6cfa9",
      operationId: "4749afac-3ee4-4bec-a440-9775307b549f",
      job: "send_webhooks",
    });
    expect(line).not.toContain("Secret");
    expect(line).not.toContain("secret");
  });
});
