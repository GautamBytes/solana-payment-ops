import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";

export const WORKER_JOB_NAMES = [
  "ingest_watch_targets",
  "refresh_finality",
  "reconcile_attempts",
  "project_payment_status",
  "expire_quotes",
  "send_webhooks",
] as const;

export type WorkerJobName = (typeof WORKER_JOB_NAMES)[number];

export interface WorkerJobLease {
  readonly name: WorkerJobName;
  readonly token: string;
  readonly expiresAt: Date;
  readonly cursor: WorkerJobCursor;
}

export type WorkerJobCursor = Readonly<
  Record<string, string | number | boolean | null>
>;

export class WorkerJobStore {
  readonly #sql: Sql;

  public constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  }

  public async claim(input: {
    readonly name: WorkerJobName;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<WorkerJobLease | null> {
    validateJobName(input.name);
    validateDate(input.now);
    if (
      !Number.isInteger(input.leaseMs) ||
      input.leaseMs < 5_000 ||
      input.leaseMs > 120_000
    ) {
      throw new TypeError("Worker lease must be 5 to 120 seconds");
    }
    const token = randomUUID();
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const rows = await this.#sql<
      { name: WorkerJobName; cursor: WorkerJobCursor }[]
    >`
      UPDATE worker_job_states SET lease_token = ${token}::uuid,
        lease_expires_at = ${expiresAt.toISOString()},
        last_started_at = ${input.now.toISOString()}, last_error_code = null,
        version = version + 1, updated_at = ${input.now.toISOString()}
      WHERE name = ${input.name}
        AND (lease_token IS NULL OR lease_expires_at <= ${input.now.toISOString()})
      RETURNING name, cursor
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : { name: input.name, token, expiresAt, cursor: row.cursor };
  }

  public async complete(input: {
    readonly lease: WorkerJobLease;
    readonly now: Date;
    readonly cursor?: WorkerJobCursor;
    readonly errorCode?: string;
  }): Promise<boolean> {
    validateJobName(input.lease.name);
    validateDate(input.now);
    const errorCode = input.errorCode ?? null;
    if (errorCode !== null && !/^[a-z0-9_]{1,64}$/.test(errorCode)) {
      throw new TypeError("Worker error code is invalid");
    }
    const cursor = input.cursor ?? {};
    const serializedCursor = JSON.stringify(cursor);
    if (
      serializedCursor.length > 16_384 ||
      cursor === null ||
      Array.isArray(cursor)
    ) {
      throw new TypeError("Worker cursor is invalid");
    }
    const rows = await this.#sql<{ name: string }[]>`
      UPDATE worker_job_states SET lease_token = null, lease_expires_at = null,
        cursor = ${this.#sql.json({ ...cursor })},
        last_completed_at = ${input.now.toISOString()},
        last_error_code = ${errorCode}, version = version + 1,
        updated_at = ${input.now.toISOString()}
      WHERE name = ${input.lease.name}
        AND lease_token = ${input.lease.token}::uuid
      RETURNING name
    `;
    return rows.length === 1;
  }

  public async renew(input: {
    readonly lease: WorkerJobLease;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<WorkerJobLease | null> {
    validateDate(input.now);
    if (
      !Number.isInteger(input.leaseMs) ||
      input.leaseMs < 5_000 ||
      input.leaseMs > 120_000
    ) {
      throw new TypeError("Worker lease must be 5 to 120 seconds");
    }
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const rows = await this.#sql<{ name: string }[]>`
      UPDATE worker_job_states SET lease_expires_at = ${expiresAt.toISOString()},
        updated_at = ${input.now.toISOString()}
      WHERE name = ${input.lease.name}
        AND lease_token = ${input.lease.token}::uuid
        AND lease_expires_at > ${input.now.toISOString()}
      RETURNING name
    `;
    return rows.length === 1 ? { ...input.lease, expiresAt } : null;
  }

  public async release(lease: WorkerJobLease, now: Date): Promise<boolean> {
    validateDate(now);
    const rows = await this.#sql<{ name: string }[]>`
      UPDATE worker_job_states SET lease_token = null, lease_expires_at = null,
        last_completed_at = ${now.toISOString()},
        last_error_code = 'worker_stopped', updated_at = ${now.toISOString()}
      WHERE name = ${lease.name} AND lease_token = ${lease.token}::uuid
      RETURNING name
    `;
    return rows.length === 1;
  }

  public async assertReady(): Promise<void> {
    const rows = await this.#sql<{ ready: boolean }[]>`
      SELECT count(*) = ${WORKER_JOB_NAMES.length} AS ready
      FROM worker_job_states
      WHERE name = ANY(${WORKER_JOB_NAMES as unknown as string[]})
    `;
    if (rows[0]?.ready !== true) {
      throw new Error("Worker schema is not ready");
    }
  }

  public async close(): Promise<void> {
    await this.#sql.end();
  }
}

function validateJobName(value: string): asserts value is WorkerJobName {
  if (!(WORKER_JOB_NAMES as readonly string[]).includes(value)) {
    throw new TypeError("Worker job name is invalid");
  }
}

function validateDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("Worker timestamp is invalid");
  }
}
