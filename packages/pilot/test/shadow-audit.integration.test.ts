import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PaymentFixtureSchema } from "@payops/core";
import {
  PostgresIngestionStore,
  type AddressSignature,
  type Commitment,
  type SignaturePageRequest,
  type SolanaRpcPort,
  type TransactionStatus,
} from "@payops/ingestion";
import { PostgresReconciliationStore } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePilotManifest } from "../src/manifest/parse-manifest.js";
import { createShadowAuditRunner } from "../src/orchestration/run-shadow-audit.js";
import { buildAuditArtifacts } from "../src/report/build-audit-report.js";
import { runPilotMigrations } from "../src/storage/migrate.js";
import { PostgresPilotStore } from "../src/storage/postgres-pilot-store.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const schema = `pilot_package_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = databaseUrlForSchema(baseDatabaseUrl, schema);
const flowSchema = `pilot_flow_${randomUUID().replaceAll("-", "")}`;
const flowDatabaseUrl = databaseUrlForSchema(baseDatabaseUrl, flowSchema);
const adminSql = postgres(baseDatabaseUrl, {
  max: 1,
  onnotice: () => undefined,
});
const sql = postgres(databaseUrl, { max: 1 });
const flowSql = postgres(flowDatabaseUrl, { max: 1 });

beforeAll(async () => {
  await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
  await adminSql.unsafe(`CREATE SCHEMA ${flowSchema}`);
});

afterAll(async () => {
  await sql.end();
  await flowSql.end();
  await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${flowSchema} CASCADE`);
  await adminSql.end();
});

describe("pilot package", () => {
  it("migrates a clean database through every PayOps package", async () => {
    await runPilotMigrations(databaseUrl);
    await runPilotMigrations(databaseUrl);
    await sql`
      DELETE FROM payops_schema_migrations
      WHERE name = '3001_shadow_audits'
    `;
    await runPilotMigrations(databaseUrl);

    const names = await sql<{ name: string }[]>`
      SELECT name FROM payops_schema_migrations ORDER BY name
    `;
    expect(names.map(({ name }) => name)).toEqual([
      "0001_durable_ingestion",
      "0002_finality_claim_token",
      "0003_pending_representation",
      "1001_reconciliation_pilot",
      "1002_semantic_parser_versions",
      "1003_strict_parser_versions",
      "1004_event_contract_bounds",
      "2001_transactional_webhooks",
      "2002_lifecycle_contract_v0_1",
      "3001_shadow_audits",
    ]);
  });

  it("runs one exact synthetic audit and resumes without duplicate evidence", async () => {
    await runPilotMigrations(flowDatabaseUrl);
    const manifestUrl = new URL(
      "../examples/manifest.v0.1.json",
      import.meta.url,
    );
    const manifestValue = JSON.parse(await readFile(manifestUrl, "utf8"));
    manifestValue.watches[0].cutoverSlot = "345678000";
    const parsed = await parsePilotManifest(
      JSON.stringify(manifestValue),
      fileURLToPath(new URL("../examples/", import.meta.url)),
    );
    const fixture = PaymentFixtureSchema.parse(
      JSON.parse(
        await readFile(
          new URL(
            "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    const root = await mkdtemp(join(tmpdir(), "payops-pilot-flow-"));
    const privateOutputDirectory = join(root, "private");
    const redactedOutputDirectory = join(root, "redacted");
    await mkdir(privateOutputDirectory);
    await mkdir(redactedOutputDirectory);
    try {
      const interruptedRpc = new FailingFinalityRpc(fixture.rpcTransaction);
      await expect(runAudit(interruptedRpc)).rejects.toMatchObject({
        code: "rpc_transport_error",
      });
      expect(interruptedRpc.confirmedRequests).toBe(1);
      expect(interruptedRpc.finalizedRequests).toBe(0);
      await expect(
        flowSql<{ stage: string; state: string }[]>`
          SELECT stage, state FROM pilot_run_stages
          WHERE stage IN ('sync', 'finality')
          ORDER BY ordinal
        `,
      ).resolves.toEqual([
        { stage: "sync", state: "succeeded" },
        { stage: "finality", state: "failed" },
      ]);

      const resumedRpc = new SyntheticRpc(fixture.rpcTransaction);
      const first = await runAudit(
        resumedRpc,
        new Date("2026-08-11T12:01:01.000Z"),
      );
      const firstBodies = await readArtifacts(first);

      expect(first).toMatchObject({
        state: "complete",
        resumed: true,
        warnings: [],
      });
      expect(first.privateArtifacts).toHaveLength(2);
      expect(first.redactedArtifacts).toHaveLength(2);
      expect(resumedRpc.confirmedRequests).toBe(0);
      expect(resumedRpc.finalizedRequests).toBe(1);

      const resumed = await runAudit(
        new NoRpcExpected(),
        new Date("2026-08-11T12:02:00.000Z"),
      );
      expect(resumed).toMatchObject({
        runId: first.runId,
        state: "complete",
        resumed: true,
        warnings: [],
      });
      expect(await readArtifacts(resumed)).toEqual(firstBodies);
      expect(artifactEvidence(resumed)).toEqual(artifactEvidence(first));

      const counts = await flowSql<{ name: string; count: number }[]>`
        SELECT 'runs' AS name, count(*)::integer AS count FROM pilot_runs
        UNION ALL
        SELECT 'stages', count(*)::integer FROM pilot_run_stages
        UNION ALL
        SELECT 'reports', count(*)::integer FROM pilot_reports
        UNION ALL
        SELECT 'allocations', count(*)::integer FROM reconciliation_allocations
        UNION ALL
        SELECT 'exceptions', count(*)::integer FROM reconciliation_exceptions
        UNION ALL
        SELECT 'events', count(*)::integer FROM webhook_events
        ORDER BY name
      `;
      expect(
        Object.fromEntries(counts.map(({ name, count }) => [name, count])),
      ).toEqual({
        allocations: 1,
        events: 1,
        exceptions: 0,
        reports: 4,
        runs: 1,
        stages: 6,
      });
      await expect(
        flowSql<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM pilot_run_stages
          WHERE state = 'succeeded'
        `,
      ).resolves.toEqual([{ count: 6 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    async function runAudit(
      rpc: SolanaRpcPort,
      now = new Date("2026-08-11T12:00:00.000Z"),
    ) {
      const pilotStore = new PostgresPilotStore({
        databaseUrl: flowDatabaseUrl,
      });
      const ingestionStore = new PostgresIngestionStore({
        databaseUrl: flowDatabaseUrl,
        selfHostedDefaultOrganization: true,
      });
      const reconciliationStore = new PostgresReconciliationStore({
        databaseUrl: flowDatabaseUrl,
        selfHostedDefaultOrganization: true,
      });
      const runner = createShadowAuditRunner({
        pilotStore,
        ingestionStore,
        reconciliationStore,
        makeRpc: () => rpc,
        readInvoiceCsv: async (path) => readFile(path, "utf8"),
        buildArtifacts: (input) =>
          buildAuditArtifacts(input, {
            env: {
              PAYOPS_AUDIT_SECRET:
                "synthetic-pseudonymization-secret-at-least-32-bytes",
            },
            getAuditRows: (invoiceIds, watchTargetIds) =>
              reconciliationStore.getAuditRows(invoiceIds, watchTargetIds),
          }),
      });
      return runner({
        manifest: parsed.manifest,
        manifestCanonicalJson: parsed.canonicalJson,
        manifestDigest: parsed.digest,
        invoiceCsvPath: parsed.invoiceCsvPath,
        privateOutputDirectory,
        redactedOutputDirectory,
        now: () => now,
      });
    }
  });
});

class SyntheticRpc implements SolanaRpcPort {
  public confirmedRequests = 0;
  public finalizedRequests = 0;

  public constructor(
    private readonly transaction: ReturnType<
      typeof PaymentFixtureSchema.parse
    >["rpcTransaction"],
  ) {}

  public async getSignaturesForAddress(
    request: SignaturePageRequest,
  ): Promise<readonly AddressSignature[]> {
    if (request.before !== undefined) return [];
    return [
      {
        signature: this.transaction.signature,
        slot: BigInt(this.transaction.slot),
        blockTime: BigInt(this.transaction.blockTime!),
        err: null,
        confirmationStatus: "confirmed",
      },
    ];
  }

  public async getTransaction(
    _signature: string,
    commitment: Commitment,
  ): Promise<typeof this.transaction> {
    const value = structuredClone(this.transaction);
    value.commitment = commitment;
    if (commitment === "confirmed") this.confirmedRequests += 1;
    else this.finalizedRequests += 1;
    return value;
  }

  public async getSignatureStatuses(
    signatures: readonly string[],
  ): Promise<readonly (TransactionStatus | null)[]> {
    return signatures.map((signature) => ({
      signature,
      slot: BigInt(this.transaction.slot),
      confirmationStatus: "finalized",
      err: null,
    }));
  }

  public async getSlot(_commitment: Commitment): Promise<bigint> {
    return BigInt(this.transaction.slot + 1_000);
  }
}

class FailingFinalityRpc extends SyntheticRpc {
  public override getSignatureStatuses(): Promise<readonly null[]> {
    throw new Error("synthetic finality interruption");
  }
}

class NoRpcExpected implements SolanaRpcPort {
  public getSignaturesForAddress(): Promise<readonly AddressSignature[]> {
    throw new Error("completed audit must not call RPC");
  }

  public getTransaction(): Promise<null> {
    throw new Error("completed audit must not call RPC");
  }

  public getSignatureStatuses(): Promise<readonly null[]> {
    throw new Error("completed audit must not call RPC");
  }

  public getSlot(): Promise<bigint> {
    throw new Error("completed audit must not call RPC");
  }
}

function artifactEvidence(result: {
  readonly privateArtifacts: readonly {
    readonly audience: string;
    readonly format: string;
    readonly contentDigest: string;
    readonly byteLength: number;
  }[];
  readonly redactedArtifacts: readonly {
    readonly audience: string;
    readonly format: string;
    readonly contentDigest: string;
    readonly byteLength: number;
  }[];
}) {
  return [...result.privateArtifacts, ...result.redactedArtifacts]
    .map(({ audience, format, contentDigest, byteLength }) => ({
      audience,
      format,
      contentDigest,
      byteLength,
    }))
    .sort((left, right) =>
      `${left.audience}:${left.format}`.localeCompare(
        `${right.audience}:${right.format}`,
      ),
    );
}

async function readArtifacts(result: {
  readonly privateArtifacts: readonly { readonly path: string }[];
  readonly redactedArtifacts: readonly { readonly path: string }[];
}): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(
    [...result.privateArtifacts, ...result.redactedArtifacts]
      .map(({ path }) => path)
      .sort()
      .map(
        async (path) =>
          [
            path,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ] as const,
      ),
  );
  return Object.fromEntries(entries);
}

function databaseUrlForSchema(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
