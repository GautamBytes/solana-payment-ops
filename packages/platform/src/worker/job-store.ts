import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { RpcProviderConfigurationIdentity } from "../config/rpc-provider.js";
import type { MigrationMetadata } from "../db/migrate.js";

export const WORKER_JOB_NAMES = [
  "ingest_watch_targets",
  "refresh_finality",
  "verify_rpc_consensus",
  "project_payment_status",
  "expire_quotes",
  "send_webhooks",
] as const;

export type WorkerJobName = (typeof WORKER_JOB_NAMES)[number];

export const WORKER_FAILURE_CLASSES = [
  "dependency",
  "configuration",
  "contention",
  "invariant",
  "unknown",
] as const;

export type WorkerFailureClass = (typeof WORKER_FAILURE_CLASSES)[number];

export interface WorkerInstance {
  readonly id: string;
  readonly state: "running" | "draining" | "stopped";
  readonly startedAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly rpc: RpcProviderConfigurationIdentity;
}

export interface WorkerJobLease {
  readonly name: WorkerJobName;
  readonly token: string;
  readonly instanceId: string;
  readonly expiresAt: Date;
  readonly cursor: WorkerJobCursor;
}

export type WorkerJobCursor = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface WorkerJobReadinessFact {
  readonly name: WorkerJobName;
  readonly ready: boolean;
  readonly lastAttemptedAt: Date | null;
  readonly lastSucceededAt: Date | null;
  readonly lastFailedAt: Date | null;
  readonly lastFailureClass: WorkerFailureClass | null;
}

export interface WorkerReadiness {
  readonly ready: boolean;
  readonly activeWorkers: number;
  readonly requiredJobs: readonly WorkerJobReadinessFact[];
}

export class WorkerJobStore {
  readonly #sql: Sql;

  public constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  }

  public async startInstance(input: {
    readonly buildRevision: string;
    readonly rpc: RpcProviderConfigurationIdentity;
  }): Promise<WorkerInstance> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.buildRevision)) {
      throw new TypeError("Worker build revision is invalid");
    }
    validateRpcIdentity(input.rpc);
    const id = randomUUID();
    const rows = await this.#sql<
      {
        id: string;
        state: "running";
        started_at: Date;
        last_heartbeat_at: Date;
      }[]
    >`
      INSERT INTO worker_instances (
        id, state, build_revision, started_at, last_heartbeat_at,
        rpc_mode, rpc_cluster, primary_provider_id, primary_endpoint_env,
        primary_endpoint_digest, secondary_provider_id, secondary_endpoint_env,
        secondary_endpoint_digest
      ) VALUES (
        ${id}::uuid, 'running', ${input.buildRevision},
        clock_timestamp(), clock_timestamp(), ${input.rpc.mode},
        ${input.rpc.cluster}, ${input.rpc.primaryProviderId},
        ${input.rpc.primaryEndpointEnvironment},
        ${input.rpc.primaryEndpointDigest}, ${input.rpc.secondaryProviderId},
        ${input.rpc.secondaryEndpointEnvironment},
        ${input.rpc.secondaryEndpointDigest}
      )
      RETURNING id::text, state, started_at, last_heartbeat_at
    `;
    const row = rows[0]!;
    return {
      id: row.id,
      state: row.state,
      startedAt: new Date(row.started_at),
      lastHeartbeatAt: new Date(row.last_heartbeat_at),
      rpc: input.rpc,
    };
  }

  public async heartbeat(instanceId: string): Promise<boolean> {
    validateUuid(instanceId, "Worker instance ID is invalid");
    const rows = await this.#sql<{ id: string }[]>`
      UPDATE worker_instances SET last_heartbeat_at = clock_timestamp()
      WHERE id = ${instanceId}::uuid AND state IN ('running', 'draining')
      RETURNING id::text
    `;
    return rows.length === 1;
  }

  public async drainInstance(instanceId: string): Promise<boolean> {
    validateUuid(instanceId, "Worker instance ID is invalid");
    const rows = await this.#sql<{ id: string }[]>`
      UPDATE worker_instances SET state = 'draining',
        draining_at = clock_timestamp(), last_heartbeat_at = clock_timestamp()
      WHERE id = ${instanceId}::uuid AND state = 'running'
      RETURNING id::text
    `;
    return rows.length === 1;
  }

  public async stopInstance(instanceId: string): Promise<boolean> {
    validateUuid(instanceId, "Worker instance ID is invalid");
    const rows = await this.#sql<{ id: string }[]>`
      UPDATE worker_instances SET state = 'stopped',
        stopped_at = clock_timestamp(), last_heartbeat_at = clock_timestamp()
      WHERE id = ${instanceId}::uuid AND state IN ('running', 'draining')
      RETURNING id::text
    `;
    return rows.length === 1;
  }

  public async claim(input: {
    readonly instanceId: string;
    readonly name: WorkerJobName;
    readonly now: Date;
    readonly intervalMs: number;
    readonly leaseMs: number;
  }): Promise<WorkerJobLease | null> {
    validateJobName(input.name);
    validateUuid(input.instanceId, "Worker instance ID is invalid");
    validateDate(input.now);
    if (
      !Number.isInteger(input.intervalMs) ||
      input.intervalMs < 250 ||
      input.intervalMs > 60_000
    ) {
      throw new TypeError(
        "Worker interval must be 250 milliseconds to 1 minute",
      );
    }
    if (
      !Number.isInteger(input.leaseMs) ||
      input.leaseMs < 5_000 ||
      input.leaseMs > 120_000
    ) {
      throw new TypeError("Worker lease must be 5 to 120 seconds");
    }
    const token = randomUUID();
    const rows = await this.#sql.begin<
      {
        name: WorkerJobName;
        cursor: WorkerJobCursor;
        lease_expires_at: Date;
      }[]
    >(async (transaction) => {
      const active = await transaction<{ id: string }[]>`
        UPDATE worker_instances SET last_heartbeat_at = clock_timestamp()
        WHERE id = ${input.instanceId}::uuid AND state = 'running'
        RETURNING id::text
      `;
      if (active.length !== 1) return [];
      return transaction<
        {
          name: WorkerJobName;
          cursor: WorkerJobCursor;
          lease_expires_at: Date;
        }[]
      >`
        WITH authority AS (SELECT clock_timestamp() AS now)
        UPDATE worker_job_states SET lease_token = ${token}::uuid,
          lease_owner_id = ${input.instanceId}::uuid,
          lease_expires_at = authority.now
            + ${input.leaseMs} * interval '1 millisecond',
          interval_ms = ${input.intervalMs},
          last_started_at = authority.now,
          last_attempted_at = authority.now,
          last_attempt_instance_id = ${input.instanceId}::uuid,
          attempts = attempts + 1,
          failures = failures + CASE WHEN lease_token IS NULL THEN 0 ELSE 1 END,
          consecutive_failures = consecutive_failures
            + CASE WHEN lease_token IS NULL THEN 0 ELSE 1 END,
          last_failed_at = CASE WHEN lease_token IS NULL THEN last_failed_at
            ELSE authority.now END,
          last_failure_class = CASE WHEN lease_token IS NULL
            THEN last_failure_class ELSE 'contention' END,
          last_failure_instance_id = CASE WHEN lease_token IS NULL
            THEN last_failure_instance_id ELSE ${input.instanceId}::uuid END,
          version = version + 1, updated_at = authority.now
        FROM authority
        WHERE name = ${input.name}
          AND lifecycle = 'active'
          AND (lease_token IS NULL OR lease_expires_at <= authority.now)
        RETURNING name, cursor, lease_expires_at
      `;
    });
    const row = rows[0];
    return row === undefined
      ? null
      : {
          name: input.name,
          token,
          instanceId: input.instanceId,
          expiresAt: new Date(row.lease_expires_at),
          cursor: row.cursor,
        };
  }

  public async complete(input: {
    readonly lease: WorkerJobLease;
    readonly now: Date;
    readonly cursor?: WorkerJobCursor;
    readonly failureClass?: WorkerFailureClass;
  }): Promise<boolean> {
    validateJobName(input.lease.name);
    validateDate(input.now);
    const failureClass = input.failureClass ?? null;
    if (
      failureClass !== null &&
      !(WORKER_FAILURE_CLASSES as readonly string[]).includes(failureClass)
    ) {
      throw new TypeError("Worker failure class is invalid");
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
    const rows = await this.#sql.begin(async (transaction) => {
      const updated = await transaction<{ name: string }[]>`
        WITH authority AS (SELECT clock_timestamp() AS now)
        UPDATE worker_job_states SET lease_token = null,
          lease_expires_at = null, lease_owner_id = null,
          cursor = CASE WHEN ${failureClass}::text IS NULL
            THEN ${transaction.json({ ...cursor })} ELSE cursor END,
          last_completed_at = authority.now,
          last_succeeded_at = CASE WHEN ${failureClass}::text IS NULL
            THEN authority.now ELSE last_succeeded_at END,
          last_success_instance_id = CASE WHEN ${failureClass}::text IS NULL
            THEN ${input.lease.instanceId}::uuid
            ELSE last_success_instance_id END,
          last_failed_at = CASE WHEN ${failureClass}::text IS NOT NULL
            THEN authority.now ELSE last_failed_at END,
          last_failure_instance_id = CASE WHEN ${failureClass}::text IS NOT NULL
            THEN ${input.lease.instanceId}::uuid
            ELSE last_failure_instance_id END,
          successes = successes + CASE WHEN ${failureClass}::text IS NULL THEN 1 ELSE 0 END,
          failures = failures + CASE WHEN ${failureClass}::text IS NULL THEN 0 ELSE 1 END,
          consecutive_failures = CASE WHEN ${failureClass}::text IS NULL
            THEN 0 ELSE consecutive_failures + 1 END,
          last_failure_class = ${failureClass},
          last_duration_ms = LEAST(86400000, GREATEST(0,
            floor(extract(epoch FROM (
              authority.now - last_started_at
            )) * 1000)::integer
          )),
          version = version + 1, updated_at = authority.now
        FROM authority
        WHERE name = ${input.lease.name}
          AND lease_token = ${input.lease.token}::uuid
          AND lease_owner_id = ${input.lease.instanceId}::uuid
          AND lease_expires_at > authority.now
        RETURNING name
      `;
      if (updated.length === 1) {
        await transaction`
          UPDATE worker_instances SET last_heartbeat_at = clock_timestamp()
          WHERE id = ${input.lease.instanceId}::uuid
            AND state IN ('running', 'draining')
        `;
      }
      return updated;
    });
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
    const rows = await this.#sql.begin(async (transaction) => {
      const updated = await transaction<
        { name: string; lease_expires_at: Date }[]
      >`
        WITH authority AS (SELECT clock_timestamp() AS now)
        UPDATE worker_job_states
        SET lease_expires_at = authority.now
            + ${input.leaseMs} * interval '1 millisecond',
          updated_at = authority.now
        FROM authority
        WHERE name = ${input.lease.name}
          AND lease_token = ${input.lease.token}::uuid
          AND lease_owner_id = ${input.lease.instanceId}::uuid
          AND lease_expires_at > authority.now
        RETURNING name, lease_expires_at
      `;
      if (updated.length === 1) {
        await transaction`
          UPDATE worker_instances SET last_heartbeat_at = clock_timestamp()
          WHERE id = ${input.lease.instanceId}::uuid
            AND state IN ('running', 'draining')
        `;
      }
      return updated;
    });
    const renewed = rows[0];
    return renewed === undefined
      ? null
      : { ...input.lease, expiresAt: new Date(renewed.lease_expires_at) };
  }

  public async release(lease: WorkerJobLease, now: Date): Promise<boolean> {
    validateDate(now);
    const rows = await this.#sql.begin(async (transaction) => {
      const updated = await transaction<{ name: string }[]>`
        WITH authority AS (SELECT clock_timestamp() AS now)
        UPDATE worker_job_states
        SET lease_token = null, lease_expires_at = null,
          lease_owner_id = null, failures = failures + 1,
          consecutive_failures = consecutive_failures + 1,
          last_completed_at = authority.now,
          last_failed_at = authority.now,
          last_failure_instance_id = ${lease.instanceId}::uuid,
          last_failure_class = 'contention', updated_at = authority.now
        FROM authority
        WHERE name = ${lease.name} AND lease_token = ${lease.token}::uuid
          AND lease_owner_id = ${lease.instanceId}::uuid
        RETURNING name
      `;
      if (updated.length === 1) {
        await transaction`
          UPDATE worker_instances SET last_heartbeat_at = clock_timestamp()
          WHERE id = ${lease.instanceId}::uuid
            AND state IN ('running', 'draining')
        `;
      }
      return updated;
    });
    return rows.length === 1;
  }

  public async assertReady(): Promise<void> {
    const rows = await this.#sql<{ ready: boolean }[]>`
      SELECT
        count(*) FILTER (
          WHERE lifecycle = 'active'
            AND name = ANY(${WORKER_JOB_NAMES as unknown as string[]})
        ) = ${WORKER_JOB_NAMES.length}
        AND count(*) FILTER (
          WHERE lifecycle = 'active'
            AND NOT (name = ANY(${WORKER_JOB_NAMES as unknown as string[]}))
        ) = 0 AS ready
      FROM worker_job_states
    `;
    if (rows[0]?.ready !== true) {
      throw new Error("Worker schema is not ready");
    }
  }

  public async assertMigrationsReady(
    required: readonly MigrationMetadata[],
  ): Promise<void> {
    if (
      required.length === 0 ||
      new Set(required.map(({ name }) => name)).size !== required.length ||
      required.some(
        ({ name, checksumSha256 }) =>
          !/^[0-9]{4}_[a-z0-9_]{1,96}$/.test(name) ||
          !/^[0-9a-f]{64}$/.test(checksumSha256),
      )
    ) {
      throw new TypeError("Required migration metadata is invalid");
    }
    const rows = await this.#sql<
      { name: string; checksum_sha256: string | null }[]
    >`
      SELECT name, checksum_sha256
      FROM payops_schema_migrations
      WHERE name = ANY(${required.map(({ name }) => name)})
    `;
    const actual = new Map(
      rows.map(({ name, checksum_sha256 }) => [name, checksum_sha256]),
    );
    if (
      required.some(
        ({ name, checksumSha256 }) => actual.get(name) !== checksumSha256,
      )
    ) {
      throw new Error("Platform migrations are not ready");
    }
  }

  public async readiness(input?: {
    readonly rpc: RpcProviderConfigurationIdentity;
  }): Promise<WorkerReadiness> {
    if (input !== undefined) validateRpcIdentity(input.rpc);
    const registry = await this.#sql<{ ready: boolean }[]>`
      SELECT
        count(*) FILTER (
          WHERE lifecycle = 'active'
            AND name = ANY(${WORKER_JOB_NAMES as unknown as string[]})
        ) = ${WORKER_JOB_NAMES.length}
        AND count(*) FILTER (
          WHERE lifecycle = 'active'
            AND NOT (name = ANY(${WORKER_JOB_NAMES as unknown as string[]}))
        ) = 0 AS ready
      FROM worker_job_states
    `;
    const active = await this.#sql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM worker_instances
      WHERE state = 'running'
        AND last_heartbeat_at >= clock_timestamp() - interval '30 seconds'
        AND ${input?.rpc.mode ?? null}::text IS NOT NULL
        AND rpc_mode = ${input?.rpc.mode ?? null}
        AND rpc_cluster = ${input?.rpc.cluster ?? null}
        AND primary_provider_id = ${input?.rpc.primaryProviderId ?? null}
        AND primary_endpoint_env =
          ${input?.rpc.primaryEndpointEnvironment ?? null}
        AND primary_endpoint_digest =
          ${input?.rpc.primaryEndpointDigest ?? null}
        AND secondary_provider_id IS NOT DISTINCT FROM
          ${input?.rpc.secondaryProviderId ?? null}
        AND secondary_endpoint_env IS NOT DISTINCT FROM
          ${input?.rpc.secondaryEndpointEnvironment ?? null}
        AND secondary_endpoint_digest IS NOT DISTINCT FROM
          ${input?.rpc.secondaryEndpointDigest ?? null}
    `;
    const rows = await this.#sql<
      {
        name: WorkerJobName;
        ready: boolean;
        last_attempted_at: Date | null;
        last_succeeded_at: Date | null;
        last_failed_at: Date | null;
        last_failure_class: WorkerFailureClass | null;
      }[]
    >`
      WITH matching_identities AS (
        SELECT instance.id
        FROM worker_instances AS instance
        WHERE instance.rpc_mode = ${input?.rpc.mode ?? null}
          AND instance.rpc_cluster = ${input?.rpc.cluster ?? null}
          AND instance.primary_provider_id =
            ${input?.rpc.primaryProviderId ?? null}
          AND instance.primary_endpoint_env =
            ${input?.rpc.primaryEndpointEnvironment ?? null}
          AND instance.primary_endpoint_digest =
            ${input?.rpc.primaryEndpointDigest ?? null}
          AND instance.secondary_provider_id IS NOT DISTINCT FROM
            ${input?.rpc.secondaryProviderId ?? null}
          AND instance.secondary_endpoint_env IS NOT DISTINCT FROM
            ${input?.rpc.secondaryEndpointEnvironment ?? null}
          AND instance.secondary_endpoint_digest IS NOT DISTINCT FROM
            ${input?.rpc.secondaryEndpointDigest ?? null}
          AND instance.state = 'running'
          AND instance.last_heartbeat_at
            >= clock_timestamp() - interval '30 seconds'
      )
      SELECT state.name,
        last_attempted_at IS NOT NULL
          AND last_attempted_at >= clock_timestamp()
            - make_interval(secs => GREATEST(30, interval_ms * 3 / 1000))
          AND last_succeeded_at IS NOT NULL
          AND (last_failed_at IS NULL OR last_succeeded_at >= last_failed_at)
          AND success_identity.id IS NOT NULL
          AND attempt.id IS NOT NULL
          AND CASE
            WHEN state.lease_token IS NULL
              OR state.lease_expires_at <= clock_timestamp()
            THEN true
            ELSE lease_owner.id IS NOT NULL
          END
          AND success.state = 'running'
          AND success.last_heartbeat_at >= clock_timestamp() - interval '30 seconds'
          AS ready,
        last_attempted_at, last_succeeded_at, last_failed_at,
        last_failure_class
      FROM worker_job_states AS state
      LEFT JOIN worker_instances AS success
        ON success.id = state.last_success_instance_id
      LEFT JOIN matching_identities AS success_identity
        ON success_identity.id = success.id
      LEFT JOIN matching_identities AS attempt
        ON attempt.id = state.last_attempt_instance_id
      LEFT JOIN matching_identities AS lease_owner
        ON lease_owner.id = state.lease_owner_id
      WHERE state.lifecycle = 'active'
        AND state.name = ANY(${WORKER_JOB_NAMES as unknown as string[]})
      ORDER BY state.name
    `;
    const requiredJobs = rows.map((row) => ({
      name: row.name,
      ready: row.ready,
      lastAttemptedAt:
        row.last_attempted_at === null ? null : new Date(row.last_attempted_at),
      lastSucceededAt:
        row.last_succeeded_at === null ? null : new Date(row.last_succeeded_at),
      lastFailedAt:
        row.last_failed_at === null ? null : new Date(row.last_failed_at),
      lastFailureClass: row.last_failure_class,
    }));
    const activeWorkers = active[0]?.count ?? 0;
    return {
      ready:
        registry[0]?.ready === true &&
        activeWorkers > 0 &&
        requiredJobs.length === WORKER_JOB_NAMES.length &&
        requiredJobs.every(({ ready }) => ready),
      activeWorkers,
      requiredJobs,
    };
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

function validateUuid(value: string, message: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError(message);
  }
}

function validateRpcIdentity(value: RpcProviderConfigurationIdentity): void {
  const providerPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
  const environmentPattern = /^[A-Z][A-Z0-9_]{0,127}$/;
  const digestPattern = /^[0-9a-f]{64}$/;
  if (
    (value.mode !== "single_provider" && value.mode !== "dual_provider") ||
    !["mainnet-beta", "devnet", "localnet"].includes(value.cluster) ||
    !providerPattern.test(value.primaryProviderId) ||
    !environmentPattern.test(value.primaryEndpointEnvironment) ||
    !digestPattern.test(value.primaryEndpointDigest) ||
    (value.mode === "single_provider" &&
      (value.secondaryProviderId !== null ||
        value.secondaryEndpointEnvironment !== null ||
        value.secondaryEndpointDigest !== null)) ||
    (value.mode === "dual_provider" &&
      (value.secondaryProviderId === null ||
        !providerPattern.test(value.secondaryProviderId) ||
        value.secondaryEndpointEnvironment === null ||
        !environmentPattern.test(value.secondaryEndpointEnvironment) ||
        value.secondaryEndpointDigest === null ||
        !digestPattern.test(value.secondaryEndpointDigest) ||
        value.primaryProviderId === value.secondaryProviderId))
  ) {
    throw new TypeError("Worker RPC identity is invalid");
  }
}
