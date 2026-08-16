import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  runMigrations as runIngestionMigrations,
  type AddressSignature,
  type Commitment,
  type SignaturePageRequest,
  type SolanaRpcPort,
  type TransactionStatus,
} from "@payops/ingestion";
import {
  bootstrapProductionDatabaseRoles,
  runPlatformMigrations,
  type ProductionDatabasePrincipals,
  type ProductionDatabaseRoles,
} from "@payops/platform";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  HostedWorkerJobs,
  ingestionCursorResult,
  selectIngestionTargets,
  selectPendingConsensusCandidates,
} from "../src/jobs.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_worker_jobs_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const principals = {
  migrator: `payops_worker_migrator_${process.pid}`,
  runtime: `payops_worker_runtime_${process.pid}`,
  control: `payops_worker_control_${process.pid}`,
  readinessVerifier: `payops_worker_verifier_${process.pid}`,
  shadowProjector: `payops_worker_projector_${process.pid}`,
} satisfies ProductionDatabasePrincipals;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const scoped = databaseUrl
  ? postgres(withOrganization(databaseUrl, organizationId), {
      max: 1,
      onnotice: () => undefined,
    })
  : undefined;
const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);
type RpcTransactionEnvelope = NonNullable<
  Awaited<ReturnType<SolanaRpcPort["getTransaction"]>>
>;
let finalizedTransaction: RpcTransactionEnvelope;
let productionRoles: ProductionDatabaseRoles | undefined;

describeDatabase("hosted worker target batching", () => {
  beforeAll(async () => {
    finalizedTransaction = (
      JSON.parse(await readFile(fixturePath, "utf8")) as {
        rpcTransaction: RpcTransactionEnvelope;
      }
    ).rpcTransaction;
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    for (const role of Object.values(principals)) {
      await admin!.unsafe(
        `CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
    }
    productionRoles = await bootstrapProductionDatabaseRoles(
      databaseUrl!,
      principals,
    );
    await runPlatformMigrations(databaseUrl!);
    await scoped!`
      INSERT INTO rpc_providers (
        id, cluster, endpoint_env, endpoint_label, active, created_at
      ) VALUES
        ('provider-mainnet', 'mainnet-beta', 'TEST_RPC_URL', 'test', true, now()),
        ('provider-secondary', 'mainnet-beta', 'TEST_SECONDARY_RPC_URL', 'test-2', true, now())
    `;
    await scoped!`
      INSERT INTO rpc_provider_roles (
        organization_id, cluster, role, provider_id, created_at
      ) VALUES
        (${organizationId}::uuid, 'mainnet-beta', 'primary', 'provider-mainnet', now()),
        (${organizationId}::uuid, 'mainnet-beta', 'secondary', 'provider-secondary', now())
    `;
    for (const [index, id] of [
      "target-001",
      "target-002",
      "target-003",
    ].entries()) {
      await scoped!`
        INSERT INTO watch_targets (
          id, provider_id, cluster, address, cutover_slot, overlap_slots,
          committed_head_slot, coverage, active, created_at, organization_id
        ) VALUES (
          ${id}, 'provider-mainnet', 'mainnet-beta',
          ${`1111111111111111111111111111111${index + 1}`}, 0, 64, 0,
          'complete', true, now(), ${organizationId}::uuid
        )
      `;
    }
  });

  beforeEach(async () => {
    await scoped!.unsafe(
      "TRUNCATE operational_health_signals, operational_incident_events, operational_incidents, operational_measurements, rpc_consensus_provider_observations, rpc_consensus_checks, discovered_signatures RESTART IDENTITY",
    );
  });

  afterAll(async () => {
    await scoped?.end();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of [
      ...Object.values(principals),
      ...Object.values(productionRoles ?? {}),
    ]) {
      await admin!.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin?.end();
  });

  it("continues after the last target instead of repeating the first batch", async () => {
    const first = await selectIngestionTargets(
      scoped!,
      organizationId,
      null,
      2,
    );
    expect(first.map(({ watch_target_id }) => watch_target_id)).toEqual([
      "target-001",
      "target-002",
    ]);
    const cursor = ingestionCursorResult(
      organizationId,
      first,
      2,
      first.length,
    );
    expect(cursor).toMatchObject({
      organizationId,
      watchTargetId: "target-002",
    });

    const second = await selectIngestionTargets(
      scoped!,
      organizationId,
      String(cursor.watchTargetId),
      2,
    );
    expect(second.map(({ watch_target_id }) => watch_target_id)).toEqual([
      "target-003",
    ]);
    expect(
      ingestionCursorResult(organizationId, second, 2, second.length),
    ).toEqual({ organizations: 1, processed: 1, organizationId });
  });

  it("registers only the canonical projection stage and consensus verification", async () => {
    const jobs = new HostedWorkerJobs({
      databaseUrl: databaseUrl!,
      shadowProjectorDatabaseUrl: databaseUrl!,
      environment: {
        TEST_RPC_URL: "https://primary.example",
        TEST_SECONDARY_RPC_URL: "https://secondary.example",
      },
      parserVersion: "0.2.0",
      rpc: {
        mode: "dual_provider",
        cluster: "mainnet-beta",
        primary: {
          providerId: "provider-mainnet",
          endpointEnvironment: "TEST_RPC_URL",
          endpoint: "https://primary.example",
        },
        secondary: {
          providerId: "provider-secondary",
          endpointEnvironment: "TEST_SECONDARY_RPC_URL",
          endpoint: "https://secondary.example",
        },
      },
    });
    try {
      expect(Object.keys(jobs.handlers())).toEqual([
        "ingest_watch_targets",
        "refresh_finality",
        "verify_rpc_consensus",
        "project_payment_status",
        "expire_quotes",
        "send_webhooks",
      ]);
    } finally {
      await jobs.close();
    }
  });

  it("drains durable health signals during ordinary worker processing", async () => {
    await scoped!`
      INSERT INTO rpc_consensus_checks (
        organization_id, cluster, signature, generation,
        primary_provider_id, secondary_provider_id, state,
        claim_token, claimed_until, started_at
      ) VALUES (
        ${organizationId}::uuid, 'mainnet-beta', ${"8".repeat(64)}, 1,
        'provider-mainnet', 'provider-secondary', 'pending', gen_random_uuid(),
        clock_timestamp() + interval '1 minute', clock_timestamp()
      )
    `;
    await scoped!.unsafe(
      "ALTER TABLE rpc_consensus_checks DISABLE TRIGGER rpc_consensus_checks_guard",
    );
    await scoped!`
      UPDATE rpc_consensus_checks
      SET state = 'disagreed', completed_at = clock_timestamp()
    `;
    await scoped!.unsafe(
      "ALTER TABLE rpc_consensus_checks ENABLE TRIGGER rpc_consensus_checks_guard",
    );
    await expect(scoped!`
      SELECT count(*)::integer AS count FROM operational_health_signals
      WHERE processed_at IS NULL
    `).resolves.toEqual([{ count: 2 }]);

    const jobs = createHostedJobs();
    const context = {
      instanceId: "00000000-0000-4000-8000-000000000001",
      operationId: "00000000-0000-4000-8000-000000000002",
      signal: new AbortController().signal,
      now: new Date(),
      batchSize: 10,
      concurrency: 2,
      cursor: {},
    };
    try {
      await jobs.handlers().expire_quotes!(context);
      await jobs.handlers().expire_quotes!(context);
      await expect(scoped!`
        SELECT
          (SELECT count(*)::integer FROM operational_health_signals
            WHERE processed_at IS NULL) AS pending,
          (SELECT occurrence_count FROM operational_incidents
            WHERE kind = 'rpc_disagreement') AS occurrences
      `).resolves.toEqual([{ pending: 0, occurrences: 1 }]);
    } finally {
      await jobs.close();
    }
  });

  it("selects bounded finalized consensus candidates deterministically and skips active claims", async () => {
    for (const [slot, signature] of [
      [3, "3".repeat(64)],
      [1, "1".repeat(64)],
      [2, "2".repeat(64)],
    ] as const) {
      await scoped!`
        INSERT INTO discovered_signatures (
          watch_target_id, provider_id, signature, slot, confirmation_status,
          representation_class, finality_state, observed_at
        ) VALUES (
          'target-001', 'provider-mainnet', ${signature}, ${slot}, 'finalized',
          'parsed', 'finalized', now()
        )
      `;
    }
    await scoped!`
      INSERT INTO discovered_signatures (
        watch_target_id, provider_id, signature, slot, confirmation_status,
        representation_class, finality_state, observed_at
      ) VALUES (
        'target-002', 'provider-mainnet', ${"2".repeat(64)}, 2, 'finalized',
        'parsed', 'finalized', now()
      )
    `;
    await scoped!`
      INSERT INTO rpc_consensus_checks (
        organization_id, cluster, signature, generation,
        primary_provider_id, secondary_provider_id, state,
        claim_token, claimed_until, started_at
      ) VALUES (
        ${organizationId}::uuid, 'mainnet-beta', ${"1".repeat(64)}, 1,
        'provider-mainnet', 'provider-secondary', 'pending',
        gen_random_uuid(), clock_timestamp() + interval '1 minute',
        clock_timestamp()
      )
    `;

    const candidates = await selectPendingConsensusCandidates(
      scoped!,
      organizationId,
      2,
    );
    expect(candidates).toEqual([
      {
        cluster: "mainnet-beta",
        signature: "2".repeat(64),
        primaryProviderId: "provider-mainnet",
        primaryEndpointEnvironment: "TEST_RPC_URL",
        secondaryProviderId: "provider-secondary",
        secondaryEndpointEnvironment: "TEST_SECONDARY_RPC_URL",
      },
      {
        cluster: "mainnet-beta",
        signature: "3".repeat(64),
        primaryProviderId: "provider-mainnet",
        primaryEndpointEnvironment: "TEST_RPC_URL",
        secondaryProviderId: "provider-secondary",
        secondaryEndpointEnvironment: "TEST_SECONDARY_RPC_URL",
      },
    ]);
  });

  it("verifies both persisted provider roles through FinalizedConsensusEngine", async () => {
    await insertFinalizedCandidate(finalizedTransaction.signature, 1);
    const primary = new FinalizedRpc(finalizedTransaction);
    const secondary = new FinalizedRpc(finalizedTransaction);
    const jobs = createHostedJobs({
      rpcForProvider: (providerId) =>
        providerId === "provider-mainnet" ? primary : secondary,
    });
    try {
      const result = await jobs.handlers().verify_rpc_consensus!({
        instanceId: "00000000-0000-4000-8000-000000000001",
        operationId: "00000000-0000-4000-8000-000000000002",
        signal: new AbortController().signal,
        now: new Date(),
        batchSize: 10,
        concurrency: 2,
        cursor: {},
      });
      expect(result).toMatchObject({ verified: 1, agreed: 1, pending: 0 });
      expect(primary.transactionRequests).toEqual([
        finalizedTransaction.signature,
      ]);
      expect(secondary.transactionRequests).toEqual([
        finalizedTransaction.signature,
      ]);
      await expect(
        scoped!<{ state: string; observations: number }[]>`
          SELECT state,
            (SELECT count(*)::integer
              FROM rpc_consensus_provider_observations) AS observations
          FROM rpc_consensus_checks
        `,
      ).resolves.toEqual([{ state: "agreed", observations: 2 }]);
    } finally {
      await jobs.close();
    }
  });

  it("re-verifies the current provider pair instead of replaying a legacy agreement", async () => {
    await insertFinalizedCandidate(finalizedTransaction.signature, 1);
    await scoped!`
      INSERT INTO rpc_providers (
        id, cluster, endpoint_env, endpoint_label, active, created_at
      ) VALUES
        ('legacy-primary', 'mainnet-beta', 'LEGACY_PRIMARY_RPC',
          'legacy-primary', true, now()),
        ('legacy-secondary', 'mainnet-beta', 'LEGACY_SECONDARY_RPC',
          'legacy-secondary', true, now())
    `;
    await scoped!`
      INSERT INTO rpc_consensus_checks (
        organization_id, cluster, signature, generation,
        primary_provider_id, secondary_provider_id, state,
        claim_token, claimed_until, started_at, completed_at
      ) VALUES (
        ${organizationId}::uuid, 'mainnet-beta',
        ${finalizedTransaction.signature}, 1,
        'legacy-primary', 'legacy-secondary', 'agreed', gen_random_uuid(),
        clock_timestamp(), clock_timestamp(), clock_timestamp()
      )
    `;
    const primary = new FinalizedRpc(finalizedTransaction);
    const secondary = new FinalizedRpc(finalizedTransaction);
    const jobs = createHostedJobs({
      rpcForProvider: (providerId) =>
        providerId === "provider-mainnet" ? primary : secondary,
    });
    try {
      await expect(
        jobs.handlers().verify_rpc_consensus!({
          instanceId: "00000000-0000-4000-8000-000000000001",
          operationId: "00000000-0000-4000-8000-000000000002",
          signal: new AbortController().signal,
          now: new Date(),
          batchSize: 10,
          concurrency: 2,
          cursor: {},
        }),
      ).resolves.toMatchObject({ verified: 1, agreed: 1 });
      await expect(scoped!`
        SELECT generation, primary_provider_id, secondary_provider_id, state
        FROM rpc_consensus_checks ORDER BY generation
      `).resolves.toEqual([
        {
          generation: 1,
          primary_provider_id: "legacy-primary",
          secondary_provider_id: "legacy-secondary",
          state: "agreed",
        },
        {
          generation: 2,
          primary_provider_id: "provider-mainnet",
          secondary_provider_id: "provider-secondary",
          state: "agreed",
        },
      ]);
    } finally {
      await jobs.close();
    }
  });

  it("fails closed without the secondary endpoint secret", async () => {
    await insertFinalizedCandidate(finalizedTransaction.signature, 1);
    const rpc = new FinalizedRpc(finalizedTransaction);
    const jobs = createHostedJobs({
      environment: { TEST_RPC_URL: "https://primary.example" },
      rpcForProvider: () => rpc,
    });
    try {
      await expect(
        jobs.handlers().verify_rpc_consensus!({
          instanceId: "00000000-0000-4000-8000-000000000001",
          operationId: "00000000-0000-4000-8000-000000000002",
          signal: new AbortController().signal,
          now: new Date(),
          batchSize: 10,
          concurrency: 2,
          cursor: {},
        }),
      ).rejects.toMatchObject({ code: "missing_configuration" });
      expect(rpc.transactionRequests).toEqual([]);
      await expect(
        scoped!<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM rpc_consensus_checks
        `,
      ).resolves.toEqual([{ count: 0 }]);
    } finally {
      await jobs.close();
    }
  });
});

function createHostedJobs(
  override: {
    environment?: NodeJS.ProcessEnv;
    rpcForProvider?: (providerId: string) => SolanaRpcPort;
  } = {},
): HostedWorkerJobs {
  return new HostedWorkerJobs({
    databaseUrl: databaseUrl!,
    shadowProjectorDatabaseUrl: databaseUrl!,
    environment: override.environment ?? {
      TEST_RPC_URL: "https://primary.example",
      TEST_SECONDARY_RPC_URL: "https://secondary.example",
    },
    parserVersion: "0.2.0",
    rpc: {
      mode: "dual_provider",
      cluster: "mainnet-beta",
      primary: {
        providerId: "provider-mainnet",
        endpointEnvironment: "TEST_RPC_URL",
        endpoint: "https://primary.example",
      },
      secondary: {
        providerId: "provider-secondary",
        endpointEnvironment: "TEST_SECONDARY_RPC_URL",
        endpoint: "https://secondary.example",
      },
    },
    ...(override.rpcForProvider === undefined
      ? {}
      : { rpcForProvider: override.rpcForProvider }),
  });
}

async function insertFinalizedCandidate(
  signature: string,
  slot: number,
): Promise<void> {
  await scoped!`
    INSERT INTO discovered_signatures (
      watch_target_id, provider_id, signature, slot, confirmation_status,
      representation_class, finality_state, observed_at
    ) VALUES (
      'target-001', 'provider-mainnet', ${signature}, ${slot}, 'finalized',
      'parsed', 'finalized', now()
    )
  `;
}

class FinalizedRpc implements SolanaRpcPort {
  public readonly transactionRequests: string[] = [];

  public constructor(readonly transaction: RpcTransactionEnvelope) {}

  public async getSignaturesForAddress(
    _request: SignaturePageRequest,
  ): Promise<readonly AddressSignature[]> {
    return [];
  }

  public async getTransaction(
    signature: string,
    _commitment: Commitment,
  ): Promise<RpcTransactionEnvelope | null> {
    this.transactionRequests.push(signature);
    return this.transaction;
  }

  public async getSignatureStatuses(
    signatures: readonly string[],
  ): Promise<readonly (TransactionStatus | null)[]> {
    return signatures.map((signature) => ({
      signature,
      slot: BigInt(this.transaction.slot),
      confirmationStatus: "finalized" as const,
      err: this.transaction.meta.err,
    }));
  }

  public async getSlot(_commitment: Commitment): Promise<bigint> {
    return BigInt(this.transaction.slot);
  }
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function withOrganization(urlString: string, id: string): string {
  const url = new URL(urlString);
  const existing = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existing, `-cpayops.organization_id=${id}`].filter(Boolean).join(" "),
  );
  return url.toString();
}
