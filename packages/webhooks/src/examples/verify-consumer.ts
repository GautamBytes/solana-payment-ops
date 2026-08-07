import { parseLifecycleEventEnvelope } from "../domain/parse-envelope.js";
import { verifyWebhook } from "../signing/hmac.js";

export interface ExampleWebhookRequest {
  readonly rawBody: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly signature: string;
}

export interface ExampleConsumerDependencies {
  readonly currentSecret: string;
  readonly previousSecret?: string;
  readonly now?: () => Date;
  readonly apply: (
    event: NonNullable<ReturnType<typeof parseLifecycleEventEnvelope>>,
  ) => Promise<void>;
  readonly parse?: (rawBody: string) => unknown;
}

export interface ExampleWebhookResponse {
  readonly status: 204 | 400 | 500;
}

export function createExampleConsumer(
  dependencies: ExampleConsumerDependencies,
): {
  readonly handle: (
    request: ExampleWebhookRequest,
  ) => Promise<ExampleWebhookResponse>;
} {
  const processedEventIds = new Set<string>();
  const processing = new Map<string, Promise<ExampleWebhookResponse>>();
  const parse = dependencies.parse ?? JSON.parse;
  const now = dependencies.now ?? (() => new Date());
  const secrets = [
    dependencies.currentSecret,
    ...(dependencies.previousSecret === undefined
      ? []
      : [dependencies.previousSecret]),
  ];

  return {
    async handle(request) {
      const verification = verifyWebhook(
        {
          body: request.rawBody,
          timestamp: request.timestamp,
          signature: request.signature,
        },
        secrets,
        now(),
      );
      if (!verification.ok) return { status: 400 };

      let decoded: unknown;
      try {
        decoded = parse(request.rawBody);
      } catch {
        return { status: 400 };
      }
      const event = parseLifecycleEventEnvelope(decoded);
      if (event === null || event.id !== request.eventId)
        return { status: 400 };
      if (processedEventIds.has(event.id)) return { status: 204 };
      const active = processing.get(event.id);
      if (active !== undefined) return active;

      const operation = applyOnce(event, dependencies, processedEventIds);
      processing.set(event.id, operation);
      try {
        return await operation;
      } finally {
        processing.delete(event.id);
      }
    },
  };
}

async function applyOnce(
  event: NonNullable<ReturnType<typeof parseLifecycleEventEnvelope>>,
  dependencies: ExampleConsumerDependencies,
  processedEventIds: Set<string>,
): Promise<ExampleWebhookResponse> {
  try {
    await Promise.resolve();
    await dependencies.apply(event);
    processedEventIds.add(event.id);
    return { status: 204 };
  } catch {
    return { status: 500 };
  }
}
