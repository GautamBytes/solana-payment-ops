import type {
  ParsedPilotManifest,
  PilotRunInspection,
  RunShadowAuditResult,
} from "../src/index.js";
import { runCli, type PilotCliDependencies } from "../src/cli.js";
import { describe, expect, it } from "vitest";

const runId = "b71f7d39-9bb4-4c37-a1ed-078601d8fd81";

describe("payops-pilot CLI", () => {
  const invalidArgumentSets: readonly (readonly string[])[] = [
    [],
    ["unknown"],
    ["migrate", "trailing"],
    ["audit"],
    ["audit", "validate"],
    ["audit", "validate", "--manifest", "a", "--manifest", "b"],
    ["audit", "validate", "--unknown", "value"],
    ["audit", "run", "--manifest", "a", "--private-output", "p"],
    ["audit", "inspect", "--run", "not-a-uuid"],
  ];

  it.each(invalidArgumentSets.map((args) => [args]))(
    "rejects invalid or ambiguous arguments: %j",
    async (args) => {
      const context = cliContext();

      await expect(runCli(args, context.dependencies)).resolves.toBe(2);
      expect(context.stdout).toEqual([]);
      expect(context.stderr).toHaveLength(1);
      expect(context.calls).toEqual([]);
    },
  );

  it("runs migrations with canonical redacted output", async () => {
    const context = cliContext();

    await expect(runCli(["migrate"], context.dependencies)).resolves.toBe(0);

    expect(context.calls).toEqual(["migrate:postgres://private-database"]);
    expect(JSON.parse(context.stdout.join("\n"))).toEqual({ migrated: true });
    expect(context.stdout.join("\n")).not.toContain("private-database");
    expect(context.stderr).toEqual([]);
  });

  it("validates a manifest without requiring database or secrets", async () => {
    const context = cliContext({ env: {} });

    await expect(
      runCli(
        ["audit", "validate", "--manifest", "manifest.json"],
        context.dependencies,
      ),
    ).resolves.toBe(0);

    expect(context.calls).toEqual(["manifest:manifest.json"]);
    expect(JSON.parse(context.stdout.join("\n"))).toEqual({
      digest: "a".repeat(64),
      invoiceDigest: "b".repeat(64),
      pilotId: "651cd115-6ad8-46e8-9368-6078b1620f24",
      valid: true,
      watches: 1,
    });
  });

  it("maps complete and incomplete audits to exit codes 0 and 1", async () => {
    const complete = cliContext();
    await expect(runCli(runArguments(), complete.dependencies)).resolves.toBe(
      0,
    );
    expect(JSON.parse(complete.stdout.join("\n"))).toMatchObject({
      runId,
      state: "complete",
      warnings: [],
    });

    const incomplete = cliContext({ auditState: "incomplete" });
    await expect(runCli(runArguments(), incomplete.dependencies)).resolves.toBe(
      1,
    );
    expect(JSON.parse(incomplete.stdout.join("\n"))).toMatchObject({
      runId,
      state: "incomplete",
      warnings: ["coverage_incomplete"],
    });
  });

  it.each([
    ["DATABASE_URL"],
    ["PAYOPS_MAINNET_RPC_URL"],
    ["PAYOPS_AUDIT_SECRET"],
  ])("fails before opening stores when %s is absent", async (missing) => {
    const env = { ...defaultEnv };
    delete env[missing];
    const context = cliContext({ env });

    await expect(runCli(runArguments(), context.dependencies)).resolves.toBe(2);

    expect(context.calls).toEqual(["manifest:manifest.json"]);
    expect(context.stdout).toEqual([]);
    expect(context.stderr).toEqual([
      "invalid_configuration: Configuration is invalid",
    ]);
  });

  it("inspects a run without exposing persisted manifest or endpoint values", async () => {
    const context = cliContext();

    await expect(
      runCli(["audit", "inspect", "--run", runId], context.dependencies),
    ).resolves.toBe(0);

    const output = context.stdout.join("\n");
    expect(JSON.parse(output)).toMatchObject({ id: runId, state: "complete" });
    expect(output).not.toContain("manifestBody");
    expect(output).not.toContain("PAYOPS_MAINNET_RPC_URL");
  });

  it("returns 1 for a missing run", async () => {
    const context = cliContext({ missingRun: true });

    await expect(
      runCli(["audit", "inspect", "--run", runId], context.dependencies),
    ).resolves.toBe(1);
    expect(context.stdout).toEqual([]);
    expect(context.stderr).toEqual(["audit_incomplete: Audit is incomplete"]);
  });

  it("sanitizes arbitrary hostile thrown values", async () => {
    const context = cliContext({
      loadError: new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("private proxy trap");
          },
          getPrototypeOf() {
            throw new Error("private prototype trap");
          },
        },
      ),
    });

    await expect(
      runCli(
        ["audit", "validate", "--manifest", "manifest.json"],
        context.dependencies,
      ),
    ).resolves.toBe(1);
    expect(context.stderr).toEqual([
      "database_unavailable: Audit operation failed",
    ]);
    expect(context.stderr.join("\n")).not.toContain("private");
  });
});

const defaultEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://private-database",
  PAYOPS_MAINNET_RPC_URL: "https://private-rpc.example",
  PAYOPS_AUDIT_SECRET: "private-pseudonymization-secret-at-least-32-bytes",
};

function cliContext(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly auditState?: "complete" | "incomplete";
    readonly missingRun?: boolean;
    readonly loadError?: unknown;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  const dependencies: PilotCliDependencies = {
    env: options.env ?? defaultEnv,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    loadManifest: async (path) => {
      calls.push(`manifest:${path}`);
      if (options.loadError !== undefined) throw options.loadError;
      return parsedManifest();
    },
    migrate: async (databaseUrl) => {
      calls.push(`migrate:${databaseUrl}`);
    },
    runAudit: async (): Promise<RunShadowAuditResult> => {
      calls.push("run");
      const state = options.auditState ?? "complete";
      return {
        runId,
        state,
        resumed: false,
        warnings: state === "complete" ? [] : ["coverage_incomplete"],
        privateArtifacts: [],
        redactedArtifacts: [],
      };
    },
    inspectRun: async (): Promise<PilotRunInspection | null> => {
      calls.push("inspect");
      if (options.missingRun) return null;
      return {
        id: runId,
        pilotId: "651cd115-6ad8-46e8-9368-6078b1620f24",
        manifestDigest: "a".repeat(64),
        invoiceDigest: "b".repeat(64),
        state: "complete",
        startedAt: new Date("2026-08-11T12:00:00.000Z"),
        completedAt: new Date("2026-08-11T12:01:00.000Z"),
        stages: [],
        reports: [],
      };
    },
  };
  return { dependencies, stdout, stderr, calls };
}

function runArguments(): string[] {
  return [
    "audit",
    "run",
    "--manifest",
    "manifest.json",
    "--private-output",
    "private",
    "--redacted-output",
    "redacted",
  ];
}

function parsedManifest(): ParsedPilotManifest {
  return {
    manifest: {
      schemaVersion: "0.1",
      pilotId: "651cd115-6ad8-46e8-9368-6078b1620f24",
      provider: {
        id: "mainnet-provider",
        cluster: "mainnet-beta",
        endpointEnv: "PAYOPS_MAINNET_RPC_URL",
        endpointLabel: "Merchant RPC",
      },
      watches: [
        {
          id: "treasury-primary",
          tokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
          cutoverSlot: "1",
          cutoverSignature: null,
          overlapSlots: "64",
        },
      ],
      invoices: { csvPath: "invoices.csv", expectedSha256: "b".repeat(64) },
      finality: { batchSize: 64, maxPasses: 5 },
      reporting: { pseudonymizationSecretEnv: "PAYOPS_AUDIT_SECRET" },
    },
    canonicalJson: "{}\n",
    digest: "a".repeat(64),
    invoiceCsvPath: "/safe/invoices.csv",
  };
}
