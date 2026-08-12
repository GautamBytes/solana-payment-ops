import { randomUUID } from "node:crypto";
import type { OrganizationDatabase } from "../db/organization-transaction.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class QuoteExpiryService {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async expireAvailable(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly now: Date;
    readonly limit?: number;
  }): Promise<{ readonly expired: number }> {
    const limit = input.limit ?? 50;
    if (
      !uuidPattern.test(input.organizationId) ||
      !Number.isFinite(input.now.getTime()) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new TypeError("Invalid quote expiry input");
    }
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const rows = await sql<
          { attempt_id: string; projection_version: number }[]
        >`
          SELECT attempt.id::text AS attempt_id,
            projection.version AS projection_version
          FROM payment_attempts AS attempt
          JOIN payment_quotes AS quote
            ON quote.organization_id = attempt.organization_id
            AND quote.attempt_id = attempt.id
          JOIN payment_projections AS projection
            ON projection.organization_id = attempt.organization_id
            AND projection.attempt_id = attempt.id
          WHERE attempt.organization_id = ${input.organizationId}::uuid
            AND attempt.state = 'awaiting_payment'
            AND projection.public_status = 'awaiting_payment'
            AND quote.expires_at <= ${input.now.toISOString()}
          ORDER BY quote.expires_at, attempt.id
          LIMIT ${limit}
          FOR UPDATE OF attempt, projection SKIP LOCKED
        `;
        for (const row of rows) {
          const version = row.projection_version + 1;
          await sql`
            UPDATE payment_attempts SET state = 'expired', version = version + 1,
              updated_at = ${input.now.toISOString()}
            WHERE organization_id = ${input.organizationId}::uuid
              AND id = ${row.attempt_id}::uuid AND state = 'awaiting_payment'
          `;
          await sql`
            UPDATE payment_projections SET public_status = 'expired',
              source_state = 'expired', version = ${version},
              updated_at = ${input.now.toISOString()}
            WHERE organization_id = ${input.organizationId}::uuid
              AND attempt_id = ${row.attempt_id}::uuid
              AND version = ${row.projection_version}
          `;
          await sql`
            INSERT INTO payment_status_history (
              id, organization_id, attempt_id, source_version, from_status,
              to_status, reason_code, occurred_at, created_at
            ) VALUES (
              ${randomUUID()}::uuid, ${input.organizationId}::uuid,
              ${row.attempt_id}::uuid, ${version}, 'awaiting_payment',
              'expired', 'quote_expired', ${input.now.toISOString()},
              ${input.now.toISOString()}
            )
          `;
        }
        return { expired: rows.length };
      },
    );
  }
}
