import { createHash } from "node:crypto";
import { parseLifecycleEventEnvelope, verifyWebhook } from "@payops/webhooks";
import postgres from "postgres";

export interface ReferenceWebhookRequest {
  readonly rawBody: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly signature: string;
}

export interface ReferenceWebhookResponse {
  readonly status: 204 | 400 | 500;
}

export interface ReferenceWebhookReceiver {
  readonly handle: (
    request: ReferenceWebhookRequest,
  ) => Promise<ReferenceWebhookResponse>;
  readonly close: () => Promise<void>;
}

export interface ReferenceWebhookReceiverOptions {
  readonly databaseUrl: string;
  readonly secrets: readonly string[];
  readonly now?: () => Date;
}

export async function migrateReferenceReceiver(
  databaseUrl: string,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`
        SELECT pg_advisory_xact_lock(707_101_006);

        CREATE TABLE IF NOT EXISTS reference_processed_events (
          event_id uuid PRIMARY KEY,
          payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
          processed_at timestamptz NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reference_paid_invoices (
          invoice_id text PRIMARY KEY CHECK (char_length(invoice_id) BETWEEN 1 AND 128),
          event_id uuid NOT NULL UNIQUE REFERENCES reference_processed_events(event_id),
          chain_event_id text NOT NULL CHECK (char_length(chain_event_id) BETWEEN 1 AND 128),
          mint text NOT NULL,
          amount_base_units text NOT NULL CHECK (amount_base_units ~ '^(0|[1-9][0-9]*)$'),
          applied_at timestamptz NOT NULL
        );
      `);
    });
  } finally {
    await sql.end();
  }
}

export function createReferenceWebhookReceiver(
  options: ReferenceWebhookReceiverOptions,
): ReferenceWebhookReceiver {
  if (
    options.secrets.length === 0 ||
    options.secrets.some((secret) => secret.length === 0)
  ) {
    throw new TypeError("At least one non-empty webhook secret is required");
  }
  const sql = postgres(options.databaseUrl, { max: 4 });
  const now = options.now ?? (() => new Date());
  let closed = false;

  return {
    async handle(request) {
      if (closed) return { status: 500 };
      const verification = verifyWebhook(
        {
          body: request.rawBody,
          timestamp: request.timestamp,
          signature: request.signature,
        },
        options.secrets,
        now(),
      );
      if (!verification.ok) return { status: 400 };

      let decoded: unknown;
      try {
        decoded = JSON.parse(request.rawBody);
      } catch {
        return { status: 400 };
      }
      const event = parseLifecycleEventEnvelope(decoded);
      if (
        event === null ||
        event.id !== request.eventId ||
        event.type !== "invoice.paid"
      ) {
        return { status: 400 };
      }

      const payloadDigest = createHash("sha256")
        .update(request.rawBody, "utf8")
        .digest("hex");
      const processedAt = now();
      try {
        let conflict = false;
        await sql.begin(async (transaction) => {
          const inserted = await transaction<{ readonly eventId: string }[]>`
            INSERT INTO reference_processed_events (
              event_id,
              payload_digest,
              processed_at
            )
            VALUES (
              ${event.id}::uuid,
              ${payloadDigest},
              ${processedAt}
            )
            ON CONFLICT (event_id) DO NOTHING
            RETURNING event_id::text AS "eventId"
          `;
          if (inserted.length === 0) {
            const existing = await transaction<
              { readonly payloadDigest: string }[]
            >`
              SELECT payload_digest AS "payloadDigest"
              FROM reference_processed_events
              WHERE event_id = ${event.id}::uuid
            `;
            conflict = existing[0]?.payloadDigest !== payloadDigest;
            return;
          }

          await transaction`
            INSERT INTO reference_paid_invoices (
              invoice_id,
              event_id,
              chain_event_id,
              mint,
              amount_base_units,
              applied_at
            )
            VALUES (
              ${event.data.invoiceId},
              ${event.id}::uuid,
              ${event.data.eventId},
              ${event.data.mint},
              ${event.data.amountBaseUnits},
              ${processedAt}
            )
          `;
        });
        return { status: conflict ? 400 : 204 };
      } catch {
        return { status: 500 };
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      await sql.end();
    },
  };
}
