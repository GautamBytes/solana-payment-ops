import {
  createBackfillEngine,
  createFinalityEngine,
  FinalizedConsensusEngine,
  HttpSolanaRpc,
  PostgresIngestionStore,
  type SolanaRpcPort,
} from "@payops/ingestion";
import {
  OperationalHealthStore,
  OrganizationDatabase,
  PaymentStatusProjector,
  QuoteExpiryService,
  rpcProviderConfigurationIdentity,
  type RpcProviderConfiguration,
  type WorkerJobName,
} from "@payops/platform";
import {
  PostgresWebhookStore,
  runDeliveryBatch,
  UndiciWebhookTransport,
} from "@payops/webhooks";
import postgres, { type Sql } from "postgres";
import type { WorkerJobContext, WorkerJobHandler } from "./runner.js";

interface OrganizationRow {
  readonly id: string;
}

export interface IngestionTargetRow {
  readonly provider_id: string;
  readonly cluster: "mainnet-beta" | "devnet" | "localnet";
  readonly endpoint_env: string;
  readonly watch_target_id: string;
}

interface ProviderRow {
  readonly provider_id: string;
  readonly cluster: "mainnet-beta" | "devnet" | "localnet";
  readonly endpoint_env: string;
}

export interface ConsensusCandidateRow {
  readonly cluster: "mainnet-beta" | "devnet" | "localnet";
  readonly signature: string;
  readonly primaryProviderId: string;
  readonly primaryEndpointEnvironment: string;
  readonly secondaryProviderId: string;
  readonly secondaryEndpointEnvironment: string;
}

export class HostedWorkerJobs {
  readonly #databaseUrl: string;
  readonly #shadowProjectorDatabaseUrl: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #parserVersion: string;
  readonly #rpc: RpcProviderConfiguration;
  readonly #rpcForProvider:
    | ((
        providerId: string,
        cluster: ConsensusCandidateRow["cluster"],
        endpoint: string,
        signal: AbortSignal,
      ) => SolanaRpcPort)
    | undefined;
  readonly #admin: Sql;
  readonly #shadowAdmin: Sql;

  public constructor(input: {
    readonly databaseUrl: string;
    readonly shadowProjectorDatabaseUrl: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly parserVersion: string;
    readonly rpc: RpcProviderConfiguration;
    readonly rpcForProvider?: (
      providerId: string,
      cluster: ConsensusCandidateRow["cluster"],
      endpoint: string,
      signal: AbortSignal,
    ) => SolanaRpcPort;
  }) {
    this.#databaseUrl = input.databaseUrl;
    this.#shadowProjectorDatabaseUrl = input.shadowProjectorDatabaseUrl;
    this.#environment = input.environment;
    this.#parserVersion = input.parserVersion;
    this.#rpc = input.rpc;
    this.#rpcForProvider = input.rpcForProvider;
    this.#admin = postgres(input.databaseUrl, {
      max: 2,
      onnotice: () => undefined,
    });
    this.#shadowAdmin = postgres(input.shadowProjectorDatabaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
  }

  public handlers(): Readonly<Record<WorkerJobName, WorkerJobHandler>> {
    return {
      ingest_watch_targets: (context) =>
        this.#withOperationalHealth(context, () => this.#ingest(context)),
      refresh_finality: (context) =>
        this.#withOperationalHealth(context, () =>
          this.#refreshFinality(context),
        ),
      verify_rpc_consensus: (context) =>
        this.#withOperationalHealth(context, () =>
          this.#verifyConsensus(context),
        ),
      project_payment_status: (context) =>
        this.#withOperationalHealth(context, () => this.#project(context)),
      expire_quotes: (context) =>
        this.#withOperationalHealth(context, () => this.#expire(context)),
      send_webhooks: (context) =>
        this.#withOperationalHealth(context, () => this.#sendWebhooks(context)),
    };
  }

  public async assertReady(): Promise<void> {
    await Promise.all([this.#admin`SELECT 1`, this.#shadowAdmin`SELECT 1`]);
  }

  public async close(): Promise<void> {
    await Promise.all([this.#admin.end(), this.#shadowAdmin.end()]);
  }

  async #withOperationalHealth(
    context: WorkerJobContext,
    operation: () => Promise<Record<string, string | number>>,
  ): Promise<Record<string, string | number>> {
    const organizationIds = await this.#operationalHealthOrganizations(context);
    await this.#maintainOperationalHealth(organizationIds, context.concurrency);
    try {
      const result = await operation();
      await this.#maintainOperationalHealth(
        organizationIds,
        context.concurrency,
      );
      return result;
    } catch (error) {
      await this.#maintainOperationalHealth(
        organizationIds,
        context.concurrency,
      );
      throw error;
    }
  }

  async #operationalHealthOrganizations(
    context: WorkerJobContext,
  ): Promise<readonly string[]> {
    const cursorOrganization = cursorOrganizationId(context);
    const organizations = await this.#organizations(
      context.batchSize,
      cursorOrganization,
    );
    const ids = new Set(organizations.map(({ id }) => id));
    if (
      cursorOrganization !== null &&
      (await this.#organization(cursorOrganization)) !== undefined
    ) {
      ids.add(cursorOrganization);
    }
    return [...ids];
  }

  async #maintainOperationalHealth(
    organizationIds: readonly string[],
    concurrency: number,
  ): Promise<void> {
    if (
      this.#rpc.mode !== "dual_provider" ||
      this.#rpc.cluster !== "mainnet-beta"
    ) {
      return;
    }
    await mapConcurrent(
      organizationIds,
      concurrency,
      async (organizationId) => {
        const database = new OrganizationDatabase(this.#databaseUrl, {
          max: 1,
        });
        const store = new OperationalHealthStore(database);
        try {
          await store.enqueueScheduledSignals({
            organizationId,
            actorId: "hosted-worker",
            observedAt: new Date(),
            rpc: rpcProviderConfigurationIdentity(this.#rpc),
          });
          for (let page = 0; page < 10; page += 1) {
            const processed = await store.drainSignals({
              organizationId,
              actorId: "hosted-worker",
              processedAt: new Date(),
              limit: 100,
            });
            if (processed < 100) break;
          }
        } finally {
          await database.close();
        }
      },
    );
  }

  async #ingest(
    context: WorkerJobContext,
  ): Promise<Record<string, string | number>> {
    const cursorOrganization = cursorOrganizationId(context);
    const cursorTarget = cursorWatchTargetId(context);
    const continuingOrganization =
      cursorOrganization === null || cursorTarget === null
        ? undefined
        : await this.#organization(cursorOrganization);
    const organization =
      continuingOrganization ??
      (await this.#organizations(1, cursorOrganization)).at(0);
    if (organization === undefined) {
      return { organizations: 0, processed: 0 };
    }
    const afterTarget =
      continuingOrganization === undefined ? null : cursorTarget;
    const rows = await withScopedSql(
      this.#databaseUrl,
      organization.id,
      (sql) =>
        selectIngestionTargets(
          sql,
          organization.id,
          afterTarget,
          context.batchSize,
        ),
    );
    let processed = 0;
    await mapConcurrent(rows, context.concurrency, async (row) => {
      assertRunning(context.signal);
      const endpoint = requiredOwnEnvironment(
        this.#environment,
        row.endpoint_env,
      );
      const store = new PostgresIngestionStore({
        databaseUrl: this.#databaseUrl,
        organizationId: organization.id,
        maxConnections: 2,
      });
      try {
        const engine = createBackfillEngine({
          rpc: new HttpSolanaRpc({
            cluster: row.cluster,
            endpoint,
            signal: context.signal,
          }),
          store,
          pageLimit: context.batchSize,
          parserVersion: this.#parserVersion,
        });
        await engine.syncWatchTarget({
          providerId: row.provider_id,
          watchTargetId: row.watch_target_id,
          now: context.now,
        });
        processed += 1;
      } finally {
        await store.close();
      }
    });
    return ingestionCursorResult(
      organization.id,
      rows,
      context.batchSize,
      processed,
    );
  }

  async #refreshFinality(
    context: WorkerJobContext,
  ): Promise<Record<string, string | number>> {
    const organizations = await this.#organizations(
      context.batchSize,
      cursorOrganizationId(context),
    );
    let providers = 0;
    let observations = 0;
    for (const organization of organizations) {
      assertRunning(context.signal);
      const rows = await withScopedSql(
        this.#databaseUrl,
        organization.id,
        (sql) =>
          sql<ProviderRow[]>`
            SELECT DISTINCT provider.id AS provider_id, provider.cluster,
              provider.endpoint_env
            FROM discovered_signatures AS signature
            JOIN watch_targets AS target
              ON target.id = signature.watch_target_id
            JOIN rpc_providers AS provider ON provider.id = signature.provider_id
            WHERE target.organization_id = ${organization.id}::uuid
              AND provider.active
              AND signature.finality_state IN ('detected', 'confirmed')
            ORDER BY provider.id LIMIT ${context.batchSize}
          `,
      );
      await mapConcurrent(rows, context.concurrency, async (row) => {
        assertRunning(context.signal);
        const endpoint = requiredOwnEnvironment(
          this.#environment,
          row.endpoint_env,
        );
        const store = new PostgresIngestionStore({
          databaseUrl: this.#databaseUrl,
          organizationId: organization.id,
          maxConnections: 2,
        });
        try {
          const report = await createFinalityEngine({
            rpc: new HttpSolanaRpc({
              cluster: row.cluster,
              endpoint,
              signal: context.signal,
            }),
            store,
          }).refresh({
            providerId: row.provider_id,
            limit: context.batchSize,
            now: context.now,
          });
          providers += 1;
          observations += report.observationsChecked;
        } finally {
          await store.close();
        }
      });
    }
    return cursorResult(organizations, {
      organizations: organizations.length,
      providers,
      observations,
    });
  }

  async #project(
    context: WorkerJobContext,
  ): Promise<Record<string, string | number>> {
    const organizations = await this.#organizations(
      context.batchSize,
      cursorOrganizationId(context),
    );
    let examined = 0;
    let changed = 0;
    await mapConcurrent(organizations, context.concurrency, async ({ id }) => {
      assertRunning(context.signal);
      const database = new OrganizationDatabase(this.#databaseUrl, { max: 2 });
      const shadowDatabase = new OrganizationDatabase(
        this.#shadowProjectorDatabaseUrl,
        { max: 1 },
      );
      try {
        const result = await new PaymentStatusProjector(database, {
          shadowDatabase,
          workerInstanceId: context.instanceId,
          rpc: rpcProviderConfigurationIdentity(this.#rpc),
        }).projectAvailable({
          organizationId: id,
          actorId: "hosted-worker",
          now: context.now,
          limit: context.batchSize,
        });
        examined += result.examined;
        changed += result.changed;
      } finally {
        await Promise.all([database.close(), shadowDatabase.close()]);
      }
    });
    return cursorResult(organizations, {
      organizations: organizations.length,
      examined,
      changed,
    });
  }

  async #verifyConsensus(
    context: WorkerJobContext,
  ): Promise<Record<string, string | number>> {
    if (this.#rpc.mode === "single_provider") {
      return {
        organizations: 0,
        verified: 0,
        agreed: 0,
        pending: 0,
        disagreed: 0,
      };
    }
    const organizations = await this.#organizations(
      context.batchSize,
      cursorOrganizationId(context),
    );
    let verified = 0;
    let agreed = 0;
    let pending = 0;
    let disagreed = 0;
    for (const organization of organizations) {
      assertRunning(context.signal);
      const candidates = await withScopedSql(
        this.#databaseUrl,
        organization.id,
        (sql) =>
          selectPendingConsensusCandidates(
            sql,
            organization.id,
            context.batchSize,
          ),
      );
      await mapConcurrent(
        candidates,
        context.concurrency,
        async (candidate) => {
          assertRunning(context.signal);
          assertConfiguredCandidate(candidate, this.#rpc);
          const endpoints = new Map([
            [
              candidate.primaryProviderId,
              requiredOwnEnvironment(
                this.#environment,
                candidate.primaryEndpointEnvironment,
              ),
            ],
            [
              candidate.secondaryProviderId,
              requiredOwnEnvironment(
                this.#environment,
                candidate.secondaryEndpointEnvironment,
              ),
            ],
          ]);
          const store = new PostgresIngestionStore({
            databaseUrl: this.#databaseUrl,
            organizationId: organization.id,
            maxConnections: 2,
          });
          try {
            const result = await new FinalizedConsensusEngine({
              store,
              rpcForProvider: (providerId) => {
                const endpoint = endpoints.get(providerId);
                if (endpoint === undefined) {
                  throw configurationError();
                }
                return this.#rpcForProvider === undefined
                  ? new HttpSolanaRpc({
                      cluster: candidate.cluster,
                      endpoint,
                      signal: context.signal,
                    })
                  : this.#rpcForProvider(
                      providerId,
                      candidate.cluster,
                      endpoint,
                      context.signal,
                    );
              },
            }).verify({
              primaryProviderId: candidate.primaryProviderId,
              secondaryProviderId: candidate.secondaryProviderId,
              signature: candidate.signature,
              now: context.now,
            });
            verified += 1;
            if (result.state === "agreed") agreed += 1;
            else if (result.state === "pending") pending += 1;
            else disagreed += 1;
          } finally {
            await store.close();
          }
        },
      );
    }
    return cursorResult(organizations, {
      organizations: organizations.length,
      verified,
      agreed,
      pending,
      disagreed,
    });
  }

  async #expire(
    context: WorkerJobContext,
  ): Promise<Record<string, string | number>> {
    const organizations = await this.#organizations(
      context.batchSize,
      cursorOrganizationId(context),
    );
    let expired = 0;
    await mapConcurrent(organizations, context.concurrency, async ({ id }) => {
      assertRunning(context.signal);
      const database = new OrganizationDatabase(this.#databaseUrl, { max: 2 });
      try {
        expired += (
          await new QuoteExpiryService(database).expireAvailable({
            organizationId: id,
            actorId: "hosted-worker",
            now: context.now,
            limit: context.batchSize,
          })
        ).expired;
      } finally {
        await database.close();
      }
    });
    return cursorResult(organizations, {
      organizations: organizations.length,
      expired,
    });
  }

  async #sendWebhooks(
    context: WorkerJobContext,
  ): Promise<Record<string, string | number>> {
    const organizations = await this.#organizations(
      context.batchSize,
      cursorOrganizationId(context),
    );
    let claimed = 0;
    let succeeded = 0;
    await mapConcurrent(organizations, context.concurrency, async ({ id }) => {
      assertRunning(context.signal);
      const store = new PostgresWebhookStore({
        databaseUrl: this.#databaseUrl,
        organizationId: id,
      });
      try {
        const result = await runDeliveryBatch(
          store,
          new UndiciWebhookTransport(),
          this.#environment,
          {
            limit: context.batchSize,
            leaseMs: 120_000,
            concurrency: context.concurrency,
            now: () => new Date(),
          },
        );
        claimed += result.claimed;
        succeeded += result.succeeded;
      } finally {
        await store.close();
      }
    });
    return cursorResult(organizations, {
      organizations: organizations.length,
      claimed,
      succeeded,
    });
  }

  async #organizations(
    limit: number,
    after: string | null,
  ): Promise<readonly OrganizationRow[]> {
    const rows = await this.#admin<OrganizationRow[]>`
      SELECT id::text FROM organization
      WHERE ${after}::uuid IS NULL OR id > ${after}::uuid
      ORDER BY id LIMIT ${limit}
    `;
    return rows.length === 0 && after !== null
      ? this.#admin<OrganizationRow[]>`
          SELECT id::text FROM organization ORDER BY id LIMIT ${limit}
        `
      : rows;
  }

  async #organization(id: string): Promise<OrganizationRow | undefined> {
    return (
      await this.#admin<OrganizationRow[]>`
        SELECT id::text FROM organization WHERE id = ${id}::uuid LIMIT 1
      `
    )[0];
  }
}

export async function selectIngestionTargets(
  sql: Sql,
  organizationId: string,
  afterTargetId: string | null,
  limit: number,
): Promise<readonly IngestionTargetRow[]> {
  return sql<IngestionTargetRow[]>`
    SELECT provider.id AS provider_id, provider.cluster,
      provider.endpoint_env, target.id AS watch_target_id
    FROM watch_targets AS target
    JOIN rpc_providers AS provider ON provider.id = target.provider_id
    WHERE target.organization_id = ${organizationId}::uuid
      AND (${afterTargetId}::text IS NULL OR target.id > ${afterTargetId})
      AND target.active AND provider.active
    ORDER BY target.id LIMIT ${limit}
  `;
}

export async function selectPendingConsensusCandidates(
  sql: Sql,
  organizationId: string,
  limit: number,
): Promise<readonly ConsensusCandidateRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Consensus candidate limit is invalid");
  }
  return sql<ConsensusCandidateRow[]>`
    WITH provider_pair AS (
      SELECT primary_provider.cluster,
        primary_provider.id AS "primaryProviderId",
        primary_provider.endpoint_env AS "primaryEndpointEnvironment",
        secondary_provider.id AS "secondaryProviderId",
        secondary_provider.endpoint_env AS "secondaryEndpointEnvironment"
      FROM rpc_provider_roles AS primary_role
      JOIN rpc_providers AS primary_provider
        ON primary_provider.id = primary_role.provider_id
        AND primary_provider.cluster = primary_role.cluster
        AND primary_provider.active
      JOIN rpc_provider_roles AS secondary_role
        ON secondary_role.organization_id = primary_role.organization_id
        AND secondary_role.cluster = primary_role.cluster
        AND secondary_role.role = 'secondary'
      JOIN rpc_providers AS secondary_provider
        ON secondary_provider.id = secondary_role.provider_id
        AND secondary_provider.cluster = secondary_role.cluster
        AND secondary_provider.active
      WHERE primary_role.organization_id = ${organizationId}::uuid
        AND primary_role.role = 'primary'
        AND primary_provider.id <> secondary_provider.id
    ), eligible AS (
      SELECT DISTINCT ON (signature.signature)
        pair.cluster, signature.signature, signature.slot,
        pair."primaryProviderId", pair."primaryEndpointEnvironment",
        pair."secondaryProviderId", pair."secondaryEndpointEnvironment"
      FROM provider_pair AS pair
      JOIN discovered_signatures AS signature
        ON signature.provider_id = pair."primaryProviderId"
        AND signature.finality_state = 'finalized'
      JOIN watch_targets AS target
        ON target.id = signature.watch_target_id
        AND target.organization_id = ${organizationId}::uuid
      LEFT JOIN LATERAL (
        SELECT state, completed_at, claimed_until
        FROM rpc_consensus_checks AS consensus
        WHERE consensus.organization_id = ${organizationId}::uuid
          AND consensus.cluster = pair.cluster
          AND consensus.signature = signature.signature
          AND consensus.primary_provider_id = pair."primaryProviderId"
          AND consensus.secondary_provider_id = pair."secondaryProviderId"
        ORDER BY generation DESC LIMIT 1
      ) AS latest ON true
      WHERE latest.state IS NULL OR (
        latest.state = 'pending' AND (
          latest.completed_at IS NOT NULL
          OR latest.claimed_until < clock_timestamp()
        )
      )
      ORDER BY signature.signature, signature.slot
    )
    SELECT cluster, signature, "primaryProviderId",
      "primaryEndpointEnvironment", "secondaryProviderId",
      "secondaryEndpointEnvironment"
    FROM eligible
    ORDER BY slot, signature
    LIMIT ${limit}
  `;
}

export function ingestionCursorResult(
  organizationId: string,
  rows: readonly IngestionTargetRow[],
  batchSize: number,
  processed: number,
): Record<string, string | number> {
  const counts = { organizations: 1, processed };
  const lastTarget = rows.at(-1)?.watch_target_id;
  return rows.length === batchSize && lastTarget !== undefined
    ? { ...counts, organizationId, watchTargetId: lastTarget }
    : { ...counts, organizationId };
}

async function withScopedSql<T>(
  databaseUrl: string,
  organizationId: string,
  operation: (sql: Sql) => Promise<T>,
): Promise<T> {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existing, `-cpayops.organization_id=${organizationId}`]
      .filter((value): value is string => value !== null && value.length > 0)
      .join(" "),
  );
  const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    return await operation(sql);
  } finally {
    await sql.end();
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (failure === undefined) {
        const current = index;
        index += 1;
        const value = values[current];
        if (value === undefined) return;
        try {
          await operation(value);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure !== undefined) throw failure;
}

function requiredOwnEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
    throw Object.assign(new Error("RPC configuration is invalid"), {
      code: "invalid_configuration",
    });
  }
  const value = Object.hasOwn(environment, name)
    ? environment[name]
    : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error("RPC configuration is unavailable"), {
      code: "missing_configuration",
    });
  }
  return value;
}

function assertConfiguredCandidate(
  candidate: ConsensusCandidateRow,
  configured: RpcProviderConfiguration,
): void {
  if (
    configured.mode !== "dual_provider" ||
    configured.cluster !== candidate.cluster ||
    configured.primary.providerId !== candidate.primaryProviderId ||
    configured.primary.endpointEnvironment !==
      candidate.primaryEndpointEnvironment ||
    configured.secondary?.providerId !== candidate.secondaryProviderId ||
    configured.secondary.endpointEnvironment !==
      candidate.secondaryEndpointEnvironment
  ) {
    throw configurationError();
  }
}

function configurationError(): Error & { readonly code: string } {
  return Object.assign(new Error("RPC provider roles are invalid"), {
    code: "invalid_configuration",
  });
}

function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error("Worker is stopping"), {
      code: "worker_aborted",
    });
  }
}

function cursorOrganizationId(context: WorkerJobContext): string | null {
  const value = context.cursor.organizationId;
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
    ? value
    : null;
}

function cursorWatchTargetId(context: WorkerJobContext): string | null {
  const value = context.cursor.watchTargetId;
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function cursorResult(
  organizations: readonly OrganizationRow[],
  counts: Record<string, number>,
): Record<string, string | number> {
  const organizationId = organizations.at(-1)?.id;
  return organizationId === undefined ? counts : { ...counts, organizationId };
}
