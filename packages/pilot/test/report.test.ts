import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReconciliationReportRow } from "@payops/reconciliation";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildAuditArtifactsInput } from "../src/orchestration/run-shadow-audit.js";
import {
  buildAuditArtifacts,
  type AuditArtifactBuilderDependencies,
} from "../src/report/build-audit-report.js";
import { pseudonymize } from "../src/report/pseudonymize.js";

const secret = "pilot-pseudonymization-secret-at-least-32-bytes";
const distinctive = {
  invoice: "invoice-private-<script>alert(1)</script>",
  customer: "customer-private-'&\"",
  event: "event-private-001",
  watch: "watch-private-001",
  wallet: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
  signature: "signature-private-001",
  rpcEnv: "RPC_PRIVATE_ENDPOINT_ENV",
  raw: '"accountKeys":["raw-private-fragment"]',
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("audit reports", () => {
  it("writes deterministic private and redacted artifacts from one result", async () => {
    const fixture = await outputFixture();
    const dependencies = artifactDependencies();

    const first = await buildAuditArtifacts(fixture.input, dependencies);
    const firstBodies = await artifactBodies(first);
    const second = await buildAuditArtifacts(fixture.input, dependencies);
    const secondBodies = await artifactBodies(second);

    expect(second).toEqual(first);
    expect(secondBodies).toEqual(firstBodies);
    expect(first.privateArtifacts).toHaveLength(2);
    expect(first.redactedArtifacts).toHaveLength(2);
    const privateJson = firstBodies.get("private:json")!;
    const privateCsv = firstBodies.get("private:csv")!;
    const redactedJson = firstBodies.get("redacted:json")!;
    const redactedHtml = firstBodies.get("redacted:html")!;

    expect(privateJson).toContain(distinctive.invoice);
    expect(JSON.parse(privateJson).rows[0].customerId).toBe(
      distinctive.customer,
    );
    expect(privateCsv).toContain(`"${distinctive.invoice}"`);
    for (const forbidden of [
      secret,
      distinctive.wallet,
      distinctive.signature,
      distinctive.rpcEnv,
      distinctive.raw,
    ]) {
      expect(privateJson).not.toContain(forbidden);
      expect(privateCsv).not.toContain(forbidden);
    }
    for (const forbidden of Object.values(distinctive).concat(secret)) {
      expect(redactedJson).not.toContain(forbidden);
      expect(redactedHtml).not.toContain(forbidden);
    }
    expect(redactedJson).toContain("invoice_");
    expect(redactedJson).toContain("customer_");
    expect(redactedHtml).not.toContain("<script>");
    expect(redactedHtml).toContain("Redacted merchant shadow audit");
    expect(first.redactedArtifacts.map((artifact) => artifact.path)).toEqual([
      expect.stringContaining("redacted-audit.json"),
      expect.stringContaining("redacted-audit.html"),
    ]);
    const redactedJsonArtifact = first.redactedArtifacts.find(
      (artifact) => artifact.format === "json",
    )!;
    expect(redactedHtml).toContain(redactedJsonArtifact.contentDigest);
    for (const artifact of [
      ...first.privateArtifacts,
      ...first.redactedArtifacts,
    ]) {
      expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
    }
  });

  it("uses stable domain-separated HMAC pseudonyms", () => {
    expect(pseudonymize("invoice", "same", secret)).toMatch(
      /^invoice_[0-9a-f]{12}$/,
    );
    expect(pseudonymize("invoice", "same", secret)).toBe(
      pseudonymize("invoice", "same", secret),
    );
    expect(pseudonymize("invoice", "same", secret)).not.toBe(
      pseudonymize("customer", "same", secret),
    );
  });

  it("rejects a missing or prototype-inherited secret", async () => {
    const fixture = await outputFixture();
    const inherited = Object.create({
      PAYOPS_AUDIT_SECRET: secret,
    }) as NodeJS.ProcessEnv;

    await expect(
      buildAuditArtifacts(fixture.input, artifactDependencies(inherited)),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      buildAuditArtifacts(fixture.input, artifactDependencies({})),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("atomically replaces a symlink output without changing its destination", async () => {
    const fixture = await outputFixture();
    const outside = join(fixture.root, "outside.json");
    const output = join(fixture.privateDirectory, "private-audit.json");
    await writeFile(outside, "outside sentinel", "utf8");
    await symlink(outside, output);

    await expect(
      buildAuditArtifacts(fixture.input, artifactDependencies()),
    ).resolves.toBeDefined();
    expect(await readFile(outside, "utf8")).toBe("outside sentinel");
    expect((await stat(output)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(output, "utf8"))).toHaveProperty("rows");
  });

  it("quotes CSV fields and escapes hostile HTML text", async () => {
    const fixture = await outputFixture();

    const result = await buildAuditArtifacts(
      fixture.input,
      artifactDependencies(),
    );
    const bodies = await artifactBodies(result);

    expect(bodies.get("private:csv")).toContain(`"customer-private-'&"""`);
    expect(bodies.get("redacted:html")).not.toContain("alert(1)");
  });
});

function artifactDependencies(
  env: NodeJS.ProcessEnv = { PAYOPS_AUDIT_SECRET: secret },
): AuditArtifactBuilderDependencies {
  const rows: readonly ReconciliationReportRow[] = [
    {
      invoiceId: distinctive.invoice,
      customerId: distinctive.customer,
      status: "matched",
      expectedMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountBaseUnits: "12500000",
      eventId: distinctive.event,
      ruleCode: "exact_match",
    },
  ];
  return {
    env,
    getAuditRows: async () => rows,
  };
}

async function outputFixture() {
  const root = await mkdtemp(join(tmpdir(), "payops-pilot-report-"));
  temporaryDirectories.push(root);
  const privateDirectory = join(root, "private");
  const redactedDirectory = join(root, "redacted");
  await mkdir(privateDirectory);
  await mkdir(redactedDirectory);
  const input: BuildAuditArtifactsInput = {
    runId: "b71f7d39-9bb4-4c37-a1ed-078601d8fd81",
    generatedAt: new Date("2026-08-11T12:00:00.000Z"),
    manifest: {
      schemaVersion: "0.1",
      pilotId: "651cd115-6ad8-46e8-9368-6078b1620f24",
      provider: {
        id: "provider-private",
        cluster: "mainnet-beta",
        endpointEnv: distinctive.rpcEnv,
        endpointLabel: "Private RPC",
      },
      watches: [
        {
          id: distinctive.watch,
          tokenAccount: distinctive.wallet,
          cutoverSlot: "1",
          cutoverSignature: distinctive.signature,
          overlapSlots: "64",
        },
      ],
      invoices: {
        csvPath: "private-invoices.csv",
        expectedSha256: "a".repeat(64),
      },
      finality: { batchSize: 64, maxPasses: 5 },
      reporting: {
        pseudonymizationSecretEnv: "PAYOPS_AUDIT_SECRET",
      },
    },
    invoiceIds: [distinctive.invoice],
    coverage: [
      {
        watchTargetId: distinctive.watch,
        coverage: "complete",
        capturedHeadSlot: "100",
        committedHeadSlot: "100",
        signatures: 1,
        finalized: 1,
        pendingFinality: 0,
        retriesOpen: 0,
        quarantinesOpen: 0,
      },
    ],
    reconciliation: {
      invoiceCount: 1,
      allocationCount: 1,
      exceptionCount: 0,
      exceptionsByCode: {},
      unmatchedFinalizedEvents: 0,
    },
    warnings: [],
    privateOutputDirectory: privateDirectory,
    redactedOutputDirectory: redactedDirectory,
  };
  return { root, privateDirectory, redactedDirectory, input };
}

async function artifactBodies(
  set: Awaited<ReturnType<typeof buildAuditArtifacts>>,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    [...set.privateArtifacts, ...set.redactedArtifacts].map(
      async (artifact) =>
        [
          `${artifact.audience}:${artifact.format}`,
          await readFile(artifact.path, "utf8"),
        ] as const,
    ),
  );
  return new Map(entries);
}
