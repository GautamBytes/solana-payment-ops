import { createHash } from "node:crypto";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import type { RpcProviderConfigurationIdentity } from "../config/rpc-provider.js";
import type { IdempotencyResponseCommitter } from "../idempotency/idempotency-store.js";
import { WORKER_JOB_NAMES } from "../worker/job-store.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type OrganizationActivationMode = "shadow" | "live";

export interface OrganizationProductionStatus {
  readonly organizationId: string;
  readonly activationMode: OrganizationActivationMode;
  readonly version: number;
  readonly promotedAt: string | null;
  readonly promotedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PromotionPrerequisites {
  readonly completeWatchCoverage: boolean;
  readonly freshWorkerHeartbeat: boolean;
  readonly twoActiveProductionRpcRoles: boolean;
  readonly noOpenCriticalIncident: boolean;
}

export type PromotionBlocker =
  | "watch_coverage_incomplete"
  | "worker_heartbeat_stale"
  | "production_rpc_roles_incomplete"
  | "open_critical_incident";

export interface PromotionEvaluation {
  readonly eligible: boolean;
  readonly blockers: readonly PromotionBlocker[];
  readonly prerequisites: PromotionPrerequisites;
}

export interface ProductionPromotionEvaluator {
  evaluate(
    transaction: OrganizationTransaction,
    input: {
      readonly organizationId: string;
      readonly now: Date;
      readonly rpc?: RpcProviderConfigurationIdentity;
    },
  ): Promise<PromotionPrerequisites>;
}

export const persistedProductionPromotionEvaluator: ProductionPromotionEvaluator =
  {
    async evaluate(sql, input) {
      const [coverage] = await sql<{ complete: boolean }[]>`
        SELECT count(*) > 0 AND bool_and(coverage = 'complete') AS complete
        FROM watch_targets
        WHERE organization_id = ${input.organizationId}::uuid AND active
      `;
      const [worker] = await sql<{ fresh: boolean }[]>`
        WITH configured_pair AS (
          SELECT
            max(role.provider_id) FILTER (WHERE role.role = 'primary')
              AS primary_provider_id,
            max(role.provider_id) FILTER (WHERE role.role = 'secondary')
              AS secondary_provider_id,
            max(provider.endpoint_env) FILTER (WHERE role.role = 'primary')
              AS primary_endpoint_env,
            max(provider.endpoint_env) FILTER (WHERE role.role = 'secondary')
              AS secondary_endpoint_env
          FROM rpc_provider_roles AS role
          JOIN rpc_providers AS provider
            ON provider.id = role.provider_id
            AND provider.cluster = role.cluster
            AND provider.active
          WHERE role.organization_id = ${input.organizationId}::uuid
            AND role.cluster = 'mainnet-beta'
          HAVING count(*) = 2
            AND count(DISTINCT role.provider_id) = 2
            AND count(*) FILTER (WHERE role.role = 'primary') = 1
            AND count(*) FILTER (WHERE role.role = 'secondary') = 1
            AND max(role.provider_id) FILTER (WHERE role.role = 'primary')
              = ${input.rpc?.primaryProviderId ?? null}
            AND max(role.provider_id) FILTER (WHERE role.role = 'secondary')
              = ${input.rpc?.secondaryProviderId ?? null}
            AND max(provider.endpoint_env) FILTER (WHERE role.role = 'primary')
              = ${input.rpc?.primaryEndpointEnvironment ?? null}
            AND max(provider.endpoint_env) FILTER (WHERE role.role = 'secondary')
              = ${input.rpc?.secondaryEndpointEnvironment ?? null}
        ), matching_identities AS (
          SELECT instance.id, instance.state, instance.last_heartbeat_at
          FROM worker_instances AS instance
          CROSS JOIN configured_pair AS pair
          WHERE instance.rpc_mode = 'dual_provider'
            AND instance.rpc_cluster = 'mainnet-beta'
            AND instance.primary_provider_id = pair.primary_provider_id
            AND instance.secondary_provider_id = pair.secondary_provider_id
            AND instance.primary_endpoint_env = pair.primary_endpoint_env
            AND instance.secondary_endpoint_env = pair.secondary_endpoint_env
            AND instance.primary_endpoint_digest =
              ${input.rpc?.primaryEndpointDigest ?? null}
            AND instance.secondary_endpoint_digest =
              ${input.rpc?.secondaryEndpointDigest ?? null}
            AND instance.state = 'running'
            AND instance.last_heartbeat_at
              >= clock_timestamp() - interval '30 seconds'
        ), matching_workers AS (
          SELECT identity.id
          FROM matching_identities AS identity
          WHERE identity.state = 'running'
            AND identity.last_heartbeat_at
              >= clock_timestamp() - interval '30 seconds'
        )
        SELECT
          EXISTS (
            SELECT 1 FROM matching_workers
          )
          AND (
            SELECT count(*) = ${WORKER_JOB_NAMES.length}
              AND bool_and(
                state.last_attempted_at IS NOT NULL
                AND state.last_attempted_at >= clock_timestamp()
                  - make_interval(
                      secs => GREATEST(30, state.interval_ms * 3 / 1000)
                )
                AND state.last_succeeded_at IS NOT NULL
                AND (
                  state.last_failed_at IS NULL
                  OR state.last_succeeded_at >= state.last_failed_at
                )
                AND success.id IS NOT NULL
                AND attempt.id IS NOT NULL
                AND CASE
                  WHEN state.lease_token IS NULL
                    OR state.lease_expires_at <= clock_timestamp()
                  THEN true
                  ELSE lease_owner.id IS NOT NULL
                END
              )
            FROM worker_job_states AS state
            LEFT JOIN matching_workers AS success
              ON success.id = state.last_success_instance_id
            LEFT JOIN matching_identities AS attempt
              ON attempt.id = state.last_attempt_instance_id
            LEFT JOIN matching_identities AS lease_owner
              ON lease_owner.id = state.lease_owner_id
            WHERE state.lifecycle = 'active'
              AND state.name = ANY(${WORKER_JOB_NAMES as unknown as string[]})
          )
          AND NOT EXISTS (
            SELECT 1 FROM worker_job_states AS unexpected
            WHERE unexpected.lifecycle = 'active'
              AND NOT (
                unexpected.name = ANY(${WORKER_JOB_NAMES as unknown as string[]})
              )
          ) AS fresh
      `;
      const [roles] = await sql<{ complete: boolean }[]>`
        SELECT count(*) = 2
          AND count(DISTINCT role.provider_id) = 2
          AND count(*) FILTER (WHERE role.role = 'primary') = 1
          AND count(*) FILTER (WHERE role.role = 'secondary') = 1
          AND bool_and(CASE role.role
            WHEN 'primary' THEN
              role.provider_id = ${input.rpc?.primaryProviderId ?? null}
              AND provider.endpoint_env =
                ${input.rpc?.primaryEndpointEnvironment ?? null}
            WHEN 'secondary' THEN
              role.provider_id = ${input.rpc?.secondaryProviderId ?? null}
              AND provider.endpoint_env =
                ${input.rpc?.secondaryEndpointEnvironment ?? null}
            ELSE false
          END)
          AS complete
        FROM rpc_provider_roles AS role
        JOIN rpc_providers AS provider
          ON provider.id = role.provider_id
          AND provider.cluster = role.cluster
          AND provider.active
        WHERE role.organization_id = ${input.organizationId}::uuid
          AND role.cluster = 'mainnet-beta'
      `;
      return {
        completeWatchCoverage: coverage?.complete === true,
        freshWorkerHeartbeat: worker?.fresh === true,
        twoActiveProductionRpcRoles: roles?.complete === true,
        noOpenCriticalIncident: true,
      };
    },
  };

export type PromotionResult =
  | {
      readonly outcome: "blocked";
      readonly status: OrganizationProductionStatus;
      readonly evaluation: PromotionEvaluation;
    }
  | {
      readonly outcome: "promoted" | "already_live";
      readonly status: OrganizationProductionStatus;
    };

export interface ProductionPromotionIdempotency {
  readonly committer: IdempotencyResponseCommitter;
  readonly response: (result: PromotionResult) => {
    readonly status: number;
    readonly body: unknown;
  };
  readonly errorResponse?: (
    code:
      "production_control_not_found" | "production_control_version_conflict",
  ) => { readonly status: number; readonly body: unknown };
}

export class ProductionControlError extends Error {
  public readonly code: string;
  public readonly idempotencyCompleted: boolean;

  public constructor(
    code: string,
    cause?: unknown,
    idempotencyCompleted: boolean = false,
  ) {
    super(
      "Production control operation failed",
      cause === undefined ? {} : { cause },
    );
    this.name = "ProductionControlError";
    this.code = code;
    this.idempotencyCompleted = idempotencyCompleted;
  }
}

export class ProductionControlStore {
  readonly #database: OrganizationDatabase;
  readonly #controlDatabase: OrganizationDatabase;
  readonly #readinessVerifierDatabase: OrganizationDatabase;
  readonly #evaluator: ProductionPromotionEvaluator;
  readonly #rpc: RpcProviderConfigurationIdentity | undefined;

  public constructor(
    database: OrganizationDatabase,
    evaluator: ProductionPromotionEvaluator,
    options: {
      readonly controlDatabase?: OrganizationDatabase;
      readonly readinessVerifierDatabase?: OrganizationDatabase;
      readonly rpc?: RpcProviderConfigurationIdentity;
    } = {},
  ) {
    this.#database = database;
    this.#controlDatabase = options.controlDatabase ?? database;
    this.#readinessVerifierDatabase =
      options.readinessVerifierDatabase ?? database;
    this.#evaluator = evaluator;
    this.#rpc = options.rpc;
  }

  public async getStatus(input: {
    readonly organizationId: string;
    readonly actorId: string;
  }): Promise<OrganizationProductionStatus> {
    validateIdentity(input.organizationId, input.actorId);
    return this.#database.transaction(input, (sql) =>
      selectStatus(sql, input.organizationId),
    );
  }

  public async evaluatePromotion(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly now: Date;
  }): Promise<PromotionEvaluation> {
    validateIdentity(input.organizationId, input.actorId);
    validateDate(input.now);
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        await selectStatus(sql, input.organizationId);
        return evaluate(
          await evaluatePromotionPrerequisites(
            sql,
            input.organizationId,
            input.now,
            this.#evaluator,
            this.#rpc,
          ),
        );
      },
    );
  }

  public async promoteLive(input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key" | "system";
    readonly actorId: string;
    readonly auditRequestId: string;
    readonly expectedVersion: number;
    readonly now: Date;
    readonly idempotency?: ProductionPromotionIdempotency;
  }): Promise<PromotionResult> {
    validatePromotionInput(input);
    const evaluated = await this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        let current: OrganizationProductionStatus;
        try {
          current = await selectStatus(sql, input.organizationId);
        } catch (error) {
          if (
            error instanceof ProductionControlError &&
            error.code === "production_control_not_found" &&
            input.idempotency?.errorResponse !== undefined
          ) {
            await completePromotionError(
              sql,
              input.idempotency,
              "production_control_not_found",
            );
            return { error: "production_control_not_found" as const };
          }
          throw error;
        }
        if (current.activationMode === "live") return undefined;
        if (current.version !== input.expectedVersion) {
          if (input.idempotency?.errorResponse !== undefined) {
            await completePromotionError(
              sql,
              input.idempotency,
              "production_control_version_conflict",
            );
            return { error: "production_control_version_conflict" as const };
          }
          throw new ProductionControlError(
            "production_control_version_conflict",
          );
        }
        const evaluation = evaluate(
          await evaluatePromotionPrerequisites(
            sql,
            input.organizationId,
            input.now,
            this.#evaluator,
            this.#rpc,
          ),
        );
        const timestamps = await sql<{ evaluated_at: Date }[]>`
          SELECT clock_timestamp() AS evaluated_at
        `;
        return { evaluation, evaluatedAt: timestamps[0]!.evaluated_at };
      },
    );
    if (evaluated !== undefined && "error" in evaluated) {
      throw new ProductionControlError(evaluated.error, undefined, true);
    }
    const evaluation = evaluated?.evaluation;
    const attestationId =
      evaluated === undefined
        ? null
        : await this.#readinessVerifierDatabase.transaction(
            { organizationId: input.organizationId, actorId: input.actorId },
            async (sql) => {
              const expiresAt = new Date(
                evaluated.evaluatedAt.getTime() + 60_000,
              );
              const rows = await sql<{ attestation_id: string }[]>`
            SELECT payops_attest_production_readiness(
            ${input.organizationId}::uuid, ${input.expectedVersion}::integer,
            ${evaluated.evaluation.prerequisites.completeWatchCoverage},
            ${evaluated.evaluation.prerequisites.freshWorkerHeartbeat},
            ${evaluated.evaluation.prerequisites.twoActiveProductionRpcRoles},
            ${evaluated.evaluation.prerequisites.noOpenCriticalIncident},
            ${evaluated.evaluatedAt.toISOString()}::timestamptz,
            ${expiresAt.toISOString()}::timestamptz
            )::text AS attestation_id
          `;
              return rows[0]!.attestation_id;
            },
          );
    try {
      return await this.#controlDatabase.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (sql) => {
          const rows = await sql<PromotionWorkflowRow[]>`
            SELECT outcome, organization_id::text, activation_mode, version,
              promoted_at, promoted_by, created_at, updated_at,
              complete_watch_coverage, fresh_worker_heartbeat,
              two_active_production_rpc_roles, no_open_critical_incident
            FROM payops_request_production_promotion(
              ${input.organizationId}::uuid, ${input.expectedVersion}::integer,
              ${input.now.toISOString()}::timestamptz, ${input.actorId},
              ${input.actorKind}, ${input.auditRequestId}::uuid,
              ${attestationId}::uuid
            )
          `;
          const row = rows[0];
          if (row === undefined)
            throw new ProductionControlError("production_control_not_found");
          const status = toStatus(row);
          const result: PromotionResult =
            row.outcome === "already_live"
              ? { outcome: "already_live", status }
              : row.outcome === "blocked"
                ? {
                    outcome: "blocked",
                    status,
                    evaluation: evaluate({
                      completeWatchCoverage:
                        row.complete_watch_coverage === true,
                      freshWorkerHeartbeat: row.fresh_worker_heartbeat === true,
                      twoActiveProductionRpcRoles:
                        row.two_active_production_rpc_roles === true,
                      noOpenCriticalIncident:
                        row.no_open_critical_incident === true,
                    }),
                  }
                : { outcome: "promoted", status };
          if (input.idempotency !== undefined) {
            const response = input.idempotency.response(result);
            await input.idempotency.committer.complete(
              sql,
              response.status,
              response.body,
            );
          }
          return result;
        },
      );
    } catch (error) {
      if (postgresErrorCode(error) === "40001") {
        throw new ProductionControlError(
          "production_control_version_conflict",
          error,
        );
      }
      throw error;
    }
  }
}

export async function lockOrganizationActivationMode(
  sql: OrganizationTransaction,
  organizationId: string,
): Promise<OrganizationActivationMode> {
  const rows = await sql<{ activation_mode: OrganizationActivationMode }[]>`
    SELECT payops_lock_production_activation_mode(
      ${organizationId}::uuid
    ) AS activation_mode
  `;
  const mode = rows[0]?.activation_mode;
  if (mode === undefined)
    throw new ProductionControlError("production_control_not_found");
  return mode;
}

export interface ShadowProjectionDecisionInput {
  readonly organizationId: string;
  readonly chainEventId: string;
  readonly sourceEventId: string;
  readonly attemptId: string;
  readonly parserVersion: string;
  readonly proposedClassification: "allocation" | "exception";
  readonly proposedInvoiceId: string | null;
  readonly proposedInvoiceStatus: "paid" | "unchanged";
  readonly proposedJournalSource:
    "payment_received" | "unapplied_receipt" | null;
  readonly ruleCode: string;
  readonly ruleVersion: string;
  readonly canonicalInputDigest: string;
  readonly occurredAt: Date;
}

export async function persistShadowProjectionDecision(
  sql: OrganizationTransaction,
  input: ShadowProjectionDecisionInput,
): Promise<boolean> {
  const id = deterministicUuid(
    [
      input.organizationId,
      input.chainEventId,
      input.attemptId,
      input.canonicalInputDigest,
      input.ruleVersion,
    ].join(":"),
  );
  const rows = await sql<{ created: boolean }[]>`
    SELECT payops_record_shadow_projection_decision(
      ${id}::uuid, ${input.organizationId}::uuid,
      ${input.chainEventId}::bigint, ${input.sourceEventId},
      ${input.attemptId}::uuid, ${input.parserVersion},
      ${input.proposedClassification},
      ${input.proposedInvoiceId}::uuid, ${input.proposedInvoiceStatus},
      ${input.proposedJournalSource}, ${input.ruleCode}, ${input.ruleVersion},
      ${input.canonicalInputDigest}, ${input.occurredAt.toISOString()}
    ) AS created
  `;
  return rows[0]?.created === true;
}

interface ProductionControlRow {
  readonly organization_id: string;
  readonly activation_mode: OrganizationActivationMode;
  readonly version: number;
  readonly promoted_at: Date | null;
  readonly promoted_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface PromotionWorkflowRow extends ProductionControlRow {
  readonly outcome: "blocked" | "promoted" | "already_live";
  readonly complete_watch_coverage: boolean | null;
  readonly fresh_worker_heartbeat: boolean | null;
  readonly two_active_production_rpc_roles: boolean | null;
  readonly no_open_critical_incident: boolean | null;
}

async function completePromotionError(
  sql: OrganizationTransaction,
  idempotency: ProductionPromotionIdempotency,
  code: "production_control_not_found" | "production_control_version_conflict",
): Promise<void> {
  const response = idempotency.errorResponse?.(code);
  if (response === undefined) return;
  await idempotency.committer.complete(sql, response.status, response.body);
}

async function selectStatus(
  sql: OrganizationTransaction,
  organizationId: string,
): Promise<OrganizationProductionStatus> {
  const query = sql<ProductionControlRow[]>`
    SELECT organization_id::text, activation_mode, version,
      promoted_at, promoted_by, created_at, updated_at
    FROM organization_production_controls
    WHERE organization_id = ${organizationId}::uuid
  `;
  const row = (await query)[0];
  if (row === undefined) {
    throw new ProductionControlError("production_control_not_found");
  }
  return toStatus(row);
}

async function evaluatePromotionPrerequisites(
  sql: OrganizationTransaction,
  organizationId: string,
  now: Date,
  evaluator: ProductionPromotionEvaluator,
  rpc: RpcProviderConfigurationIdentity | undefined,
): Promise<PromotionPrerequisites> {
  const healthClear = await acquireOperationalHealthAuthorityLock(
    sql,
    organizationId,
  );
  const prerequisites = await evaluator.evaluate(sql, {
    organizationId,
    now,
    ...(rpc === undefined ? {} : { rpc }),
  });
  return {
    ...prerequisites,
    noOpenCriticalIncident: prerequisites.noOpenCriticalIncident && healthClear,
  };
}

async function acquireOperationalHealthAuthorityLock(
  sql: OrganizationTransaction,
  organizationId: string,
): Promise<boolean> {
  const [health] = await sql<{ clear: boolean }[]>`
    SELECT payops_operational_health_clear_for_promotion(
      ${organizationId}::uuid
    ) AS clear
  `;
  return health?.clear === true;
}

function toStatus(row: ProductionControlRow): OrganizationProductionStatus {
  return {
    organizationId: row.organization_id,
    activationMode: row.activation_mode,
    version: row.version,
    promotedAt: row.promoted_at?.toISOString() ?? null,
    promotedBy: row.promoted_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function evaluate(prerequisites: PromotionPrerequisites): PromotionEvaluation {
  const blockers: PromotionBlocker[] = [];
  if (!prerequisites.completeWatchCoverage)
    blockers.push("watch_coverage_incomplete");
  if (!prerequisites.freshWorkerHeartbeat)
    blockers.push("worker_heartbeat_stale");
  if (!prerequisites.twoActiveProductionRpcRoles)
    blockers.push("production_rpc_roles_incomplete");
  if (!prerequisites.noOpenCriticalIncident)
    blockers.push("open_critical_incident");
  return { eligible: blockers.length === 0, blockers, prerequisites };
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256")
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validatePromotionInput(input: {
  readonly organizationId: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly auditRequestId: string;
  readonly expectedVersion: number;
  readonly now: Date;
}): void {
  validateIdentity(input.organizationId, input.actorId);
  validateDate(input.now);
  if (
    !uuidPattern.test(input.auditRequestId) ||
    !["session", "api_key", "system"].includes(input.actorKind) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new ProductionControlError("invalid_production_control_input");
  }
}

function validateIdentity(organizationId: string, actorId: string): void {
  if (
    !uuidPattern.test(organizationId) ||
    !/^[\x21-\x7e]{1,128}$/.test(actorId)
  ) {
    throw new ProductionControlError("invalid_production_control_input");
  }
}

function validateDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new ProductionControlError("invalid_production_control_input");
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}
