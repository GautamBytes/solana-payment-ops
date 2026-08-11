import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { Agent, buildConnector } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifecycleEvent,
  runDeliveryBatch,
  UndiciWebhookTransport,
  verifyWebhook,
  type ClaimedDelivery,
  type CompleteDeliveryInput,
  type DeliveryStore,
} from "../src/index.js";
import type { PinnedDispatcherFactoryInput } from "../src/transport/https-transport.js";
import { TEST_SIGNATURE } from "./support/lifecycle-events.js";

const certificateUrl = new URL(
  "./fixtures/TEST_ONLY_receiver.test.cert.pem",
  import.meta.url,
);
const privateKeyUrl = new URL(
  "./fixtures/TEST_ONLY_receiver.test.key.pem",
  import.meta.url,
);
const startedAt = new Date("2026-08-07T10:00:00.000Z");
const secret = "actual-https-test-secret";
const received: ReceivedRequest[] = [];
const serverNames: string[] = [];
let redirectTargetHits = 0;
let certificate: string;
let serverPort: number;

const server = createServer({}, async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const path = request.url ?? "";
  received.push({
    path,
    host: request.headers.host ?? "",
    body: Buffer.concat(chunks).toString("utf8"),
    headers: request.headers,
  });
  if (path === "/redirect") {
    response.writeHead(307, {
      location: "https://receiver.test/redirect-target",
    });
    response.end();
    return;
  }
  if (path === "/redirect-target") {
    redirectTargetHits += 1;
    response.writeHead(204).end();
    return;
  }
  const deliveryNumber = received.filter(
    (item) => item.path === "/deliver",
  ).length;
  response.writeHead(deliveryNumber === 1 ? 500 : 204).end();
});

beforeAll(async () => {
  const [key, cert] = await Promise.all([
    readFile(privateKeyUrl, "utf8"),
    readFile(certificateUrl, "utf8"),
  ]);
  certificate = cert;
  server.setSecureContext({ key, cert });
  server.on("secureConnection", (socket: TLSSocket) => {
    serverNames.push(
      typeof socket.servername === "string" ? socket.servername : "",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      serverPort = address.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe("real pinned HTTPS transport", () => {
  it("retries identical signed bytes over real TLS from 500 to 204", async () => {
    const event = createLifecycleEvent(
      {
        type: "invoice.paid",
        statusAtOccurrence: "matched",
        object: { type: "invoice", id: "inv-real-https", version: 1 },
        data: {
          invoiceId: "inv-real-https",
          customerId: "customer-real-https",
          eventId: "event-real-https",
          signature: TEST_SIGNATURE,
          outerInstructionIndex: 0,
          innerInstructionIndex: null,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amountBaseUnits: "12500000",
          ruleCode: "exact_match",
          ruleVersion: "0.1",
        },
      },
      "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      startedAt,
    );
    const claims = [1, 2].map((attemptNumber): ClaimedDelivery => ({
      deliveryId: "6ba7b811-9dad-41d1-80b4-00c04fd430c8",
      leaseToken: `lease-${attemptNumber}`,
      attemptNumber,
      firstAttemptAt: startedAt,
      manualReplay: false,
      manualReplayRecovery: false,
      endpoint: {
        id: "real-https",
        url: "https://receiver.test/deliver",
        secretEnv: "REAL_HTTPS_SECRET",
        previousSecretEnv: null,
      },
      event: {
        id: event.id,
        eventType: event.eventType,
        payload: event.payload,
        digest: event.digest,
        occurredAt: event.occurredAt,
      },
    }));
    const store = new SequencedStore(claims);
    const transport = createRealTestTransport();
    let now = startedAt;
    const options = {
      limit: 1,
      leaseMs: 30_000,
      now: () => now,
      random: () => 0.5,
    };

    await expect(
      runDeliveryBatch(
        store,
        transport,
        { REAL_HTTPS_SECRET: secret },
        options,
      ),
    ).resolves.toMatchObject({ retryScheduled: 1, succeeded: 0 });
    now = store.completions[0]!.nextAttemptAt!;
    await expect(
      runDeliveryBatch(
        store,
        transport,
        { REAL_HTTPS_SECRET: secret },
        options,
      ),
    ).resolves.toMatchObject({ retryScheduled: 0, succeeded: 1 });

    const deliveries = received.filter(
      (request) => request.path === "/deliver",
    );
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((request) => request.body)).toEqual([
      event.payload,
      event.payload,
    ]);
    expect(deliveries.map((request) => request.host)).toEqual([
      "receiver.test",
      "receiver.test",
    ]);
    expect(serverNames.slice(0, 2)).toEqual(["receiver.test", "receiver.test"]);
    for (const request of deliveries) {
      expect(
        verifyWebhook(
          {
            body: request.body,
            timestamp: header(request, "payops-timestamp"),
            signature: header(request, "payops-signature"),
          },
          [secret],
          new Date(Number(header(request, "payops-timestamp")) * 1_000),
        ),
      ).toEqual({ ok: true, secretIndex: 0 });
    }
    expect(store.completions).toMatchObject([
      { state: "retry_wait", httpStatus: 500, errorCode: "http_500" },
      { state: "succeeded", httpStatus: 204, errorCode: null },
    ]);
  });

  it("returns a redirect without following it", async () => {
    const transport = createRealTestTransport();

    await expect(
      transport.send({
        url: "https://receiver.test/redirect",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    ).resolves.toMatchObject({ status: 307 });
    expect(redirectTargetHits).toBe(0);
    expect(received.at(-1)).toMatchObject({
      path: "/redirect",
      host: "receiver.test",
    });
    expect(serverNames.at(-1)).toBe("receiver.test");
  });
});

interface ReceivedRequest {
  readonly path: string;
  readonly host: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

class SequencedStore implements DeliveryStore {
  readonly completions: CompleteDeliveryInput[] = [];
  readonly #claims: ClaimedDelivery[];

  public constructor(claims: ClaimedDelivery[]) {
    this.#claims = [...claims];
  }

  public async claimDueDeliveries(): Promise<readonly ClaimedDelivery[]> {
    const claim = this.#claims.shift();
    return claim === undefined ? [] : [claim];
  }

  public async completeDelivery(
    input: CompleteDeliveryInput,
  ): Promise<boolean> {
    this.completions.push(input);
    return true;
  }
}

function createRealTestTransport(): UndiciWebhookTransport {
  return new UndiciWebhookTransport(
    { endpointPolicy: { allowUnsafeAddressesForTesting: true } },
    {
      resolver: async (hostname) => {
        expect(hostname).toBe("receiver.test");
        return [{ address: "127.0.0.1", family: 4 }];
      },
      createDispatcher: (input) => testDispatcher(input),
    },
  );
}

function testDispatcher(input: PinnedDispatcherFactoryInput): Agent {
  const connector = buildConnector({
    ca: certificate,
    rejectUnauthorized: true,
    timeout: input.connectTimeoutMs,
  });
  return new Agent({
    connect(options, callback) {
      connector(
        {
          ...options,
          hostname: input.address,
          host: input.address,
          port: String(serverPort),
          servername: input.hostname,
        },
        callback,
      );
    },
    maxResponseSize: input.maxResponseBodyBytes,
  });
}

function header(request: ReceivedRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string") throw new Error(`Missing ${name} header`);
  return value;
}
